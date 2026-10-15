import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import type { ApprovalDTO, ApprovalDecision, ApprovalRequest, UserDTO } from "@relayroom/protocol";
import type { Ctx } from "./ctx.js";
import { Outbox } from "./ctx.js";
import type { DbOrTx } from "../db/client.js";
import { agents, approvals, dispatches, projects } from "../db/schema.js";
import { conflict, forbidden, notFound } from "../lib/errors.js";
import { postSystemMessage } from "./message-store.js";
import { requireMember } from "./projects.js";
import { broadcastAgent } from "./agent-view.js";

type ApprovalRow = typeof approvals.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function approvalDTOs(db: DbOrTx, rows: ApprovalRow[]): Promise<ApprovalDTO[]> {
  if (!rows.length) return [];
  const ds = await db
    .select({ id: dispatches.id, requestedBy: dispatches.requestedBy })
    .from(dispatches)
    .where(inArray(dispatches.id, [...new Set(rows.map((r) => r.dispatchId))]));
  const as = await db
    .select({ id: agents.id, ownerId: agents.ownerId })
    .from(agents)
    .where(inArray(agents.id, [...new Set(rows.map((r) => r.agentId))]));
  return rows.map((a) => ({
    id: a.id,
    projectId: a.projectId,
    dispatchId: a.dispatchId,
    agentId: a.agentId,
    toolName: a.toolName,
    summary: a.summary,
    detail: a.detail,
    status: a.status,
    requestedBy: ds.find((d) => d.id === a.dispatchId)?.requestedBy ?? "",
    agentOwnerId: as.find((x) => x.id === a.agentId)?.ownerId ?? "",
    reason: a.reason,
    decidedBy: a.decidedBy ? { id: a.decidedBy, name: a.decidedByName ?? "unknown" } : null,
    createdAt: a.createdAt.toISOString(),
    expiresAt: a.expiresAt.toISOString(),
    decidedAt: iso(a.decidedAt),
  }));
}

function decisionOf(a: ApprovalRow): ApprovalDecision | undefined {
  if (a.status === "pending") return undefined;
  return {
    approvalId: a.id,
    dispatchId: a.dispatchId,
    status: a.status,
    reason: a.reason,
    decidedBy: a.decidedBy ? { id: a.decidedBy, name: a.decidedByName ?? "unknown" } : null,
  };
}

/** Queues the room broadcast and, for decided rows, the decision for the adapter. */
function announce(outbox: Outbox, rows: ApprovalRow[], notifyAdapter: boolean): void {
  if (!rows.length) return;
  outbox.add(async (c) => {
    for (const dto of await approvalDTOs(c.db, rows)) c.hub.toProject(dto.projectId, "approval:updated", dto);
    if (!notifyAdapter) return;
    for (const r of rows) {
      const d = decisionOf(r);
      if (d) c.hub.sendApprovalDecision(r.agentId, d);
    }
  });
}

const short = (s: string, n = 160) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

/** Expiry is checked by a timer per request and, as a backstop (e.g. after a restart), by the sweeper. */
function scheduleExpiry(ctx: Ctx, expiresAt: Date): void {
  const t = setTimeout(
    () => void expireDueApprovals(ctx).catch((err) => ctx.log.error({ err }, "approval expiry failed")),
    Math.max(0, expiresAt.getTime() - Date.now()) + 50,
  );
  t.unref();
}

/**
 * The adapter asks the room whether its agent may perform an action. Idempotent per approvalId:
 * a re-send after a reconnect returns the decision if one was already made.
 */
export async function requestApproval(
  ctx: Ctx,
  agentId: string,
  req: ApprovalRequest,
): Promise<{ ok: boolean; error?: string; decision?: ApprovalDecision }> {
  const outbox = new Outbox();
  const res = await ctx.db.transaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.id, req.dispatchId), eq(dispatches.agentId, agentId)));
    if (!d) return { ok: false, error: "Unknown dispatch" };
    const existing = async () => {
      const [a] = await tx.select().from(approvals).where(eq(approvals.id, req.approvalId));
      if (!a) return null;
      if (a.dispatchId !== d.id || a.agentId !== agentId) return { ok: false, error: "Unknown approval" };
      return { ok: true, decision: decisionOf(a) };
    };
    const prior = await existing();
    if (prior) return prior;
    if (d.status !== "running") return { ok: false, error: "Dispatch is not running" };
    if (d.cancelRequested) {
      return {
        ok: true,
        decision: { approvalId: req.approvalId, dispatchId: d.id, status: "cancelled" as const, reason: "Cancellation was requested", decidedBy: null },
      };
    }
    const [row] = await tx
      .insert(approvals)
      .values({
        id: req.approvalId,
        projectId: d.projectId,
        dispatchId: d.id,
        agentId,
        toolName: req.toolName,
        summary: req.summary,
        detail: req.detail,
        expiresAt: new Date(Date.now() + req.timeoutMs),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return (await existing()) ?? { ok: false, error: "Unknown approval" };
    const [agent] = await tx
      .update(agents)
      .set({ lastEvent: `Waiting for approval: ${short(req.summary, 150)}`, lastEventAt: new Date() })
      .where(eq(agents.id, agentId))
      .returning();
    await postSystemMessage(
      tx,
      outbox,
      d.projectId,
      `${agent?.displayName ?? "The agent"} is waiting for approval to use ${req.toolName}: ${short(req.summary)}`,
      { dispatchId: d.id, taskId: d.taskId, meta: { notice: "approval_requested", approvalId: row.id } },
    );
    announce(outbox, [row], false);
    outbox.add((c) => broadcastAgent(c, agentId));
    outbox.add((c) => scheduleExpiry(c, row.expiresAt));
    return { ok: true };
  });
  await outbox.flush(ctx);
  return res;
}

/** Only the person who asked for the run, the agent's owner or the project owner may decide. */
export async function decideApproval(
  ctx: Ctx,
  user: UserDTO,
  approvalId: string,
  body: { decision: "approve" | "deny"; reason: string },
): Promise<{ approval: ApprovalDTO; delivered: boolean }> {
  const [a0] = await ctx.db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!a0) throw notFound("Approval request not found");
  await requireMember(ctx.db, a0.projectId, user.id);
  const [d] = await ctx.db.select({ requestedBy: dispatches.requestedBy }).from(dispatches).where(eq(dispatches.id, a0.dispatchId));
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, a0.agentId));
  const [p] = await ctx.db.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, a0.projectId));
  if (d?.requestedBy !== user.id && agent?.ownerId !== user.id && p?.ownerId !== user.id) {
    throw forbidden("Only the person who asked for this run, the agent owner or the project owner can decide");
  }
  const status = body.decision === "approve" ? ("approved" as const) : ("denied" as const);
  const outbox = new Outbox();
  const row = await ctx.db.transaction(async (tx) => {
    const [r] = await tx
      .update(approvals)
      .set({
        status,
        reason: body.reason || null,
        decidedBy: user.id,
        decidedByName: user.displayName,
        decidedAt: new Date(),
      })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending"), gt(approvals.expiresAt, new Date())))
      .returning();
    if (!r) return null;
    await postSystemMessage(
      tx,
      outbox,
      r.projectId,
      `${user.displayName} ${status} ${agent?.displayName ?? "the agent"}'s request to use ${r.toolName}: ${short(r.summary)}${
        r.reason ? ` (“${short(r.reason, 200)}”)` : ""
      }`,
      { dispatchId: r.dispatchId, meta: { notice: "approval_decided", approvalId: r.id, status } },
    );
    await tx
      .update(agents)
      .set({ lastEvent: `Approval ${status} by ${user.displayName}`, lastEventAt: new Date() })
      .where(eq(agents.id, r.agentId));
    announce(outbox, [r], true);
    outbox.add((c) => broadcastAgent(c, r.agentId));
    return r;
  });
  if (!row) {
    await expireDueApprovals(ctx);
    const [now] = await ctx.db.select().from(approvals).where(eq(approvals.id, approvalId));
    throw conflict(`This request is already ${now?.status ?? "closed"}`);
  }
  await outbox.flush(ctx);
  const [dto] = await approvalDTOs(ctx.db, [row]);
  return { approval: dto!, delivered: ctx.hub.isAgentConnected(row.agentId) };
}

/** Pending requests past their deadline become `expired`, which the adapter treats as a denial. */
export async function expireDueApprovals(ctx: Ctx): Promise<number> {
  const outbox = new Outbox();
  const n = await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .update(approvals)
      .set({ status: "expired", reason: "No decision in time", decidedAt: new Date() })
      .where(and(eq(approvals.status, "pending"), lte(approvals.expiresAt, new Date())))
      .returning();
    for (const r of rows) {
      await postSystemMessage(tx, outbox, r.projectId, `No one decided in time, so the request to use ${r.toolName} was denied: ${short(r.summary)}`, {
        dispatchId: r.dispatchId,
        meta: { notice: "approval_expired", approvalId: r.id },
      });
    }
    announce(outbox, rows, true);
    return rows.length;
  });
  await outbox.flush(ctx);
  return n;
}

/** The run ended (finished, cancelled, interrupted): its open requests can no longer be answered. */
export async function cancelPendingApprovals(db: DbOrTx, outbox: Outbox, dispatchId: string, reason: string, notifyAdapter = false): Promise<void> {
  const rows = await db
    .update(approvals)
    .set({ status: "cancelled", reason, decidedAt: new Date() })
    .where(and(eq(approvals.dispatchId, dispatchId), eq(approvals.status, "pending")))
    .returning();
  announce(outbox, rows, notifyAdapter);
}

export async function listApprovals(ctx: Ctx, user: UserDTO, projectId: string): Promise<ApprovalDTO[]> {
  await requireMember(ctx.db, projectId, user.id);
  const rows = await ctx.db
    .select()
    .from(approvals)
    .where(eq(approvals.projectId, projectId))
    .orderBy(desc(approvals.createdAt))
    .limit(200);
  return approvalDTOs(ctx.db, rows.reverse());
}
