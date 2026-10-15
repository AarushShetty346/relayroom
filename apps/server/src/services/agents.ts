import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { AdapterHeartbeat, AdapterHello, AgentDTO, AgentTokenDTO, UserDTO } from "@relayroom/protocol";
import type { Ctx } from "./ctx.js";
import { Outbox } from "./ctx.js";
import { agents, dispatches, projectMembers, projects, users } from "../db/schema.js";
import { newAgentToken, sha256, AGENT_TOKEN_PREFIX } from "../lib/crypto.js";
import { conflict, forbidden, notFound } from "../lib/errors.js";
import { isUniqueViolation } from "../lib/pg-errors.js";
import { requireMember } from "./projects.js";
import { agentDTOs, broadcastAgent } from "./agent-view.js";
import { postSystemMessage } from "./message-store.js";
import { interruptDispatches, pumpAgent } from "./dispatch.js";
import { dispatchDTO } from "./serialize.js";

type AgentRow = typeof agents.$inferSelect;

/** A member registers an agent identity they own. The token is returned once and stored hashed. */
export async function createAgent(
  ctx: Ctx,
  user: UserDTO,
  projectId: string,
  input: { handle: string; displayName: string; provider: AgentRow["provider"]; acceptFrom: AgentRow["acceptFrom"] },
): Promise<AgentTokenDTO> {
  await requireMember(ctx.db, projectId, user.id);
  const clash = await ctx.db
    .select({ id: users.id })
    .from(users)
    .innerJoin(projectMembers, and(eq(projectMembers.userId, users.id), eq(projectMembers.projectId, projectId)))
    .where(eq(users.username, input.handle));
  if (clash.length) throw conflict(`@${input.handle} is already a member's username in this project`);
  const token = newAgentToken();
  const outbox = new Outbox();
  try {
    const row = await ctx.db.transaction(async (tx) => {
      const [a] = await tx
        .insert(agents)
        .values({ projectId, ownerId: user.id, tokenHash: sha256(token), ...input })
        .returning();
      await postSystemMessage(
        tx,
        outbox,
        projectId,
        `${user.displayName} registered agent @${a!.handle} (${a!.provider}). It is offline until its local adapter connects.`,
      );
      return a!;
    });
    await outbox.flush(ctx);
    await broadcastAgent(ctx, row.id);
    const [dto] = await agentDTOs(ctx.db, [row], new Set());
    return { agent: dto!, token };
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`An agent with handle @${input.handle} already exists in this project`);
    throw err;
  }
}

export async function listAgents(ctx: Ctx, user: UserDTO, projectId: string): Promise<AgentDTO[]> {
  await requireMember(ctx.db, projectId, user.id);
  const rows = await ctx.db.select().from(agents).where(eq(agents.projectId, projectId)).orderBy(asc(agents.createdAt));
  const live = new Set(rows.filter((a) => ctx.hub.isAgentConnected(a.id)).map((a) => a.id));
  return agentDTOs(ctx.db, rows, live);
}

async function requireAgentAdmin(ctx: Ctx, user: UserDTO, agentId: string): Promise<AgentRow> {
  const [a] = await ctx.db.select().from(agents).where(eq(agents.id, agentId));
  if (!a) throw notFound("Agent not found");
  await requireMember(ctx.db, a.projectId, user.id);
  if (a.ownerId !== user.id) {
    const [p] = await ctx.db.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, a.projectId));
    if (p?.ownerId !== user.id) throw forbidden("Only the agent's owner or the project owner can do that");
  }
  return a;
}

/** Revokes the agent's credential: the live adapter is disconnected, queued work is cancelled. */
export async function revokeAgent(ctx: Ctx, user: UserDTO, agentId: string): Promise<void> {
  const a = await requireAgentAdmin(ctx, user, agentId);
  if (a.revokedAt) return;
  const outbox = new Outbox();
  await ctx.db.transaction(async (tx) => {
    await tx.update(agents).set({ revokedAt: new Date(), connected: false }).where(eq(agents.id, agentId));
    const cancelled = await tx
      .update(dispatches)
      .set({ status: "cancelled", cancelRequested: true, finishedAt: new Date(), error: "Agent credential revoked" })
      .where(and(eq(dispatches.agentId, agentId), eq(dispatches.status, "pending")))
      .returning();
    for (const d of cancelled) outbox.add((c) => c.hub.toProject(d.projectId, "dispatch:updated", dispatchDTO(d)));
    await postSystemMessage(tx, outbox, a.projectId, `${user.displayName} revoked the credential for @${a.handle}.`);
  });
  ctx.hub.disconnectAgent(agentId, "credential revoked");
  await outbox.flush(ctx);
  await interruptDispatches(ctx, agentId, [], "agent credential revoked");
  await broadcastAgent(ctx, agentId);
}

/** Issues a new token; the old one stops working immediately. */
export async function rotateAgentToken(ctx: Ctx, user: UserDTO, agentId: string): Promise<{ token: string }> {
  const a = await requireAgentAdmin(ctx, user, agentId);
  if (a.revokedAt) throw conflict("This agent is revoked; register a new one");
  const token = newAgentToken();
  await ctx.db.update(agents).set({ tokenHash: sha256(token), connected: false }).where(eq(agents.id, agentId));
  ctx.hub.disconnectAgent(agentId, "credential rotated");
  await broadcastAgent(ctx, agentId);
  return { token };
}

export async function authenticateAgent(ctx: Ctx, token: unknown): Promise<AgentRow | null> {
  if (typeof token !== "string" || !token.startsWith(AGENT_TOKEN_PREFIX) || token.length > 200) return null;
  const [a] = await ctx.db
    .select()
    .from(agents)
    .where(and(eq(agents.tokenHash, sha256(token)), isNull(agents.revokedAt)));
  return a ?? null;
}

/** The adapter (re)connected. Reconcile running work against what the adapter says it is executing. */
export async function adapterHello(ctx: Ctx, agentId: string, hello: AdapterHello): Promise<void> {
  await ctx.db
    .update(agents)
    .set({
      connected: true,
      lastHeartbeatAt: new Date(),
      providerVersion: hello.providerVersion,
      capabilities: hello.capabilities,
      maxPermission: hello.maxPermission,
      repo: hello.repo,
      lastEvent: "Adapter connected",
      lastEventAt: new Date(),
    })
    .where(eq(agents.id, agentId));
  await interruptDispatches(ctx, agentId, hello.activeDispatchIds, "the adapter restarted while it was running");
  // Cancellation requested while the adapter was away.
  if (hello.activeDispatchIds.length) {
    const toCancel = await ctx.db
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(
        and(
          eq(dispatches.agentId, agentId),
          inArray(dispatches.id, hello.activeDispatchIds),
          eq(dispatches.cancelRequested, true),
        ),
      );
    for (const d of toCancel) ctx.hub.cancelDispatch(agentId, d.id);
  }
  await broadcastAgent(ctx, agentId);
  await pumpAgent(ctx, agentId);
}

export async function adapterHeartbeat(ctx: Ctx, agentId: string, hb: AdapterHeartbeat): Promise<void> {
  await ctx.db
    .update(agents)
    .set({ connected: true, lastHeartbeatAt: new Date(), ...(hb.repo ? { repo: hb.repo } : {}) })
    .where(eq(agents.id, agentId));
  await broadcastAgent(ctx, agentId);
  if (hb.state === "idle") await pumpAgent(ctx, agentId);
}

export async function adapterDisconnected(ctx: Ctx, agentId: string): Promise<void> {
  await ctx.db
    .update(agents)
    .set({ connected: false, lastEvent: "Adapter disconnected", lastEventAt: new Date() })
    .where(eq(agents.id, agentId));
  await broadcastAgent(ctx, agentId);
}

/** On boot no adapter is connected yet, whatever the table says. */
export async function resetAgentConnections(ctx: Ctx): Promise<void> {
  await ctx.db.update(agents).set({ connected: false }).where(eq(agents.connected, true));
}
