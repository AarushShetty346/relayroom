import { and, asc, eq, inArray, lt, ne, notInArray, sql } from "drizzle-orm";
import {
  HEARTBEAT_TIMEOUT_MS,
  type DispatchPayload,
  type GitInfo,
  type Handoff,
  type PermissionProfile,
  type RunComplete,
  type RunEvent,
  type UserDTO,
} from "@relayroom/protocol";
import type { Ctx } from "./ctx.js";
import { Outbox } from "./ctx.js";
import type { DbOrTx } from "../db/client.js";
import { agents, dispatches, handoffs, memoryEntries, projects, runEvents, tasks, users } from "../db/schema.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { buildContext } from "./context.js";
import { insertMessage, postSystemMessage } from "./message-store.js";
import { requireMember } from "./projects.js";
import { dispatchDTO, memoryDTO } from "./serialize.js";
import { applyTransition, lockTask } from "./task-state.js";
import { broadcastAgent } from "./agent-view.js";
import { cancelPendingApprovals, expireDueApprovals } from "./approvals.js";

export type AgentRow = typeof agents.$inferSelect;
export type DispatchRow = typeof dispatches.$inferSelect;

export function isAgentOnline(ctx: Ctx, a: AgentRow): boolean {
  return (
    !a.revokedAt &&
    a.connected &&
    ctx.hub.isAgentConnected(a.id) &&
    !!a.lastHeartbeatAt &&
    Date.now() - a.lastHeartbeatAt.getTime() <= HEARTBEAT_TIMEOUT_MS
  );
}

/** Returns a human-readable reason the agent cannot take work from this user, or null. */
export async function agentAvailability(
  ctx: Ctx,
  a: AgentRow,
  requester: UserDTO,
  permission: PermissionProfile,
): Promise<string | null> {
  if (a.revokedAt) return "its credential has been revoked";
  if (a.acceptFrom === "owner" && a.ownerId !== requester.id) return "it only accepts instructions from its owner";
  if (!isAgentOnline(ctx, a)) return "its local adapter is offline";
  if (permission === "edit" && a.maxPermission === "read-only")
    return "its owner's local policy allows read-only work only";
  return null;
}

/**
 * Reasons the user should confirm before dispatching: the agent is already busy (work will queue),
 * or another agent is editing in the same project (risk of conflicting changes).
 */
export async function concurrencyWarnings(
  db: DbOrTx,
  projectId: string,
  a: AgentRow,
  permission: PermissionProfile,
  batch: AgentRow[] = [],
): Promise<string[]> {
  const reasons: string[] = [];
  const own = await db
    .select({ id: dispatches.id, status: dispatches.status })
    .from(dispatches)
    .where(and(eq(dispatches.agentId, a.id), inArray(dispatches.status, ["pending", "running"])));
  if (own.length) reasons.push(`@${a.handle} is busy (${own.length} active or queued); this will wait in its queue.`);
  if (permission === "edit") {
    const others = await db
      .select({ handle: agents.handle })
      .from(dispatches)
      .innerJoin(agents, eq(agents.id, dispatches.agentId))
      .where(
        and(
          eq(dispatches.projectId, projectId),
          ne(dispatches.agentId, a.id),
          eq(dispatches.permission, "edit"),
          inArray(dispatches.status, ["pending", "running"]),
        ),
      );
    for (const o of others) reasons.push(`@${o.handle} is already making edits in this project; concurrent edits may conflict.`);
    if (batch.filter((b) => b.id !== a.id).length)
      reasons.push(`This message would start ${batch.length} agents with edit permission at the same time.`);
  }
  return reasons;
}

export interface DispatchRequest {
  projectId: string;
  agent: AgentRow;
  requester: UserDTO;
  kind: "mention" | "task";
  instruction: string;
  taskId: string | null;
  messageId: string | null;
  permission: PermissionProfile;
  idempotencyKey: string;
}

/** Creates (or returns the existing) dispatch for an idempotency key. Delivery happens via pumpAgent. */
export async function createDispatch(db: DbOrTx, outbox: Outbox, req: DispatchRequest): Promise<DispatchRow> {
  const { items, expectedCommit } = await buildContext(db, {
    projectId: req.projectId,
    taskId: req.taskId,
    messageId: req.messageId,
    instruction: req.instruction,
  });
  const inserted = await db
    .insert(dispatches)
    .values({
      projectId: req.projectId,
      agentId: req.agent.id,
      taskId: req.taskId,
      messageId: req.messageId,
      kind: req.kind,
      instruction: req.instruction,
      context: items,
      permission: req.permission,
      expectedCommit,
      requestedBy: req.requester.id,
      idempotencyKey: req.idempotencyKey,
    })
    .onConflictDoNothing({ target: dispatches.idempotencyKey })
    .returning();
  const d =
    inserted[0] ??
    (await db.select().from(dispatches).where(eq(dispatches.idempotencyKey, req.idempotencyKey)))[0]!;
  if (inserted[0]) outbox.add((ctx) => ctx.hub.toProject(d.projectId, "dispatch:updated", dispatchDTO(d)));
  return d;
}

async function toPayload(db: DbOrTx, d: DispatchRow): Promise<DispatchPayload> {
  const [u] = await db.select().from(users).where(eq(users.id, d.requestedBy));
  return {
    dispatchId: d.id,
    projectId: d.projectId,
    agentId: d.agentId,
    taskId: d.taskId,
    kind: d.kind,
    instruction: d.instruction,
    context: d.context as DispatchPayload["context"],
    permission: d.permission,
    expectedCommit: d.expectedCommit,
    requestedBy: { id: u!.id, username: u!.username, displayName: u!.displayName },
    createdAt: d.createdAt.toISOString(),
  };
}

/**
 * Delivers the agent's oldest pending dispatch if it is connected and idle. Safe to call any number
 * of times: delivery does not change state, and only `dispatch:accept` grants execution.
 */
export async function pumpAgent(ctx: Ctx, agentId: string): Promise<void> {
  if (!ctx.hub.isAgentConnected(agentId)) return;
  const running = await ctx.db
    .select({ id: dispatches.id })
    .from(dispatches)
    .where(and(eq(dispatches.agentId, agentId), eq(dispatches.status, "running")));
  if (running.length) return;
  const [next] = await ctx.db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.agentId, agentId), eq(dispatches.status, "pending")))
    .orderBy(asc(dispatches.createdAt))
    .limit(1);
  if (!next) return;
  ctx.hub.sendDispatch(agentId, await toPayload(ctx.db, next));
}

async function agentRef(db: DbOrTx, agentId: string) {
  const [a] = await db.select().from(agents).where(eq(agents.id, agentId));
  return { row: a!, ref: { type: "agent" as const, id: agentId, name: a?.displayName ?? "agent" } };
}

/**
 * The adapter asks to start a dispatch. Granted at most once: the conditional update succeeds only
 * from `pending`, and a partial unique index allows one running dispatch per agent.
 */
export async function acceptDispatch(ctx: Ctx, agentId: string, dispatchId: string): Promise<{ ok: boolean; error?: string }> {
  const outbox = new Outbox();
  try {
    const ok = await ctx.db.transaction(async (tx) => {
      const [d] = await tx
        .update(dispatches)
        .set({ status: "running", startedAt: new Date() })
        .where(
          and(
            eq(dispatches.id, dispatchId),
            eq(dispatches.agentId, agentId),
            eq(dispatches.status, "pending"),
            eq(dispatches.cancelRequested, false),
          ),
        )
        .returning();
      if (!d) return false;
      outbox.add((c) => c.hub.toProject(d.projectId, "dispatch:updated", dispatchDTO(d)));
      const { row: agent, ref } = await agentRef(tx, agentId);
      if (d.taskId) {
        const t = await lockTask(tx, d.taskId);
        if (t && t.status === "assigned" && t.assigneeAgentId === agentId) {
          await applyTransition(tx, outbox, t, "running", "system", ref, "Adapter accepted the task");
        }
      }
      await tx
        .update(agents)
        .set({ lastEvent: "Started work", lastEventAt: new Date() })
        .where(eq(agents.id, agentId));
      await insertMessage(tx, outbox, {
        projectId: d.projectId,
        kind: "event",
        authorType: "agent",
        authorAgentId: agentId,
        body: `${agent.displayName} started working${d.taskId ? " on the task" : ""} (${d.permission}).`,
        replyToId: d.messageId,
        dispatchId: d.id,
        taskId: d.taskId,
        meta: { event: "run_started" },
      });
      outbox.add((c) => broadcastAgent(c, agentId));
      return true;
    });
    await outbox.flush(ctx);
    return ok ? { ok: true } : { ok: false, error: "Dispatch is not pending (already started, cancelled or finished)" };
  } catch (err) {
    if ((err as { code?: string }).code === "23505" || String(err).includes("dispatches_one_running_per_agent_uq")) {
      return { ok: false, error: "Agent already has a running dispatch" };
    }
    throw err;
  }
}

export async function rejectDispatch(ctx: Ctx, agentId: string, dispatchId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  const outbox = new Outbox();
  const ok = await ctx.db.transaction(async (tx) => {
    const [d] = await tx
      .update(dispatches)
      .set({ status: "rejected", error: reason, finishedAt: new Date() })
      .where(and(eq(dispatches.id, dispatchId), eq(dispatches.agentId, agentId), eq(dispatches.status, "pending")))
      .returning();
    if (!d) return false;
    outbox.add((c) => c.hub.toProject(d.projectId, "dispatch:updated", dispatchDTO(d)));
    const { ref } = await agentRef(tx, agentId);
    await postSystemMessage(tx, outbox, d.projectId, `${ref.name}'s adapter declined the request: ${reason}`, {
      replyToId: d.messageId,
      dispatchId: d.id,
      taskId: d.taskId,
      meta: { notice: "dispatch_rejected" },
    });
    if (d.taskId) {
      const t = await lockTask(tx, d.taskId);
      if (t && t.status === "assigned") await applyTransition(tx, outbox, t, "failed", "system", ref, `Adapter declined: ${reason}`);
    }
    return true;
  });
  await outbox.flush(ctx);
  await pumpAgent(ctx, agentId);
  return ok ? { ok: true } : { ok: false, error: "Dispatch is not pending" };
}

export async function recordRunEvent(ctx: Ctx, agentId: string, ev: RunEvent): Promise<{ ok: boolean; error?: string }> {
  const [d] = await ctx.db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.id, ev.dispatchId), eq(dispatches.agentId, agentId)));
  if (!d) return { ok: false, error: "Unknown dispatch" };
  if (d.status !== "running") return { ok: false, error: "Dispatch is not running" };
  const inserted = await ctx.db
    .insert(runEvents)
    .values({ dispatchId: d.id, seq: ev.seq, type: ev.type, text: ev.text })
    .onConflictDoNothing()
    .returning();
  if (!inserted[0]) return { ok: true }; // duplicate after a reconnect
  const summary = ev.text.split("\n")[0]!.slice(0, 200);
  await ctx.db.update(agents).set({ lastEvent: `${ev.type}: ${summary}`, lastEventAt: new Date() }).where(eq(agents.id, agentId));
  ctx.hub.toProject(d.projectId, "run:event", {
    dispatchId: d.id,
    seq: ev.seq,
    type: ev.type,
    text: ev.text,
    createdAt: inserted[0].createdAt.toISOString(),
  });
  await broadcastAgent(ctx, agentId);
  return { ok: true };
}

/** Changed files reported by other agents' checkouts in this project that overlap with this run's. */
async function overlappingChanges(db: DbOrTx, projectId: string, agentId: string, git: GitInfo | null) {
  if (!git?.changedFiles.length) return [];
  const mine = new Set(git.changedFiles.map((f) => f.path));
  const others = await db
    .select({ handle: agents.handle, repo: agents.repo })
    .from(agents)
    .where(and(eq(agents.projectId, projectId), ne(agents.id, agentId)));
  const hits: { handle: string; files: string[] }[] = [];
  for (const o of others) {
    const files = ((o.repo as GitInfo | null)?.changedFiles ?? []).map((f) => f.path).filter((p) => mine.has(p));
    if (files.length) hits.push({ handle: o.handle, files });
  }
  return hits;
}

/**
 * Records a finished run: the agent's reply goes into the room, the dispatch is closed, and for task
 * runs a structured handoff is stored and the task moves to awaiting_review / failed / blocked.
 * Idempotent: a repeated completion for a finished dispatch is acknowledged without side effects.
 */
export async function completeDispatch(ctx: Ctx, agentId: string, r: RunComplete): Promise<{ ok: boolean; error?: string }> {
  const outbox = new Outbox();
  const res = await ctx.db.transaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.id, r.dispatchId), eq(dispatches.agentId, agentId)))
      .for("update");
    if (!d) return { ok: false, error: "Unknown dispatch" };
    if (["succeeded", "failed", "cancelled"].includes(d.status)) return { ok: true };
    if (d.status !== "running" && d.status !== "interrupted") return { ok: false, error: `Dispatch is ${d.status}` };
    const late = d.status === "interrupted";
    const outcome = d.cancelRequested && r.outcome !== "succeeded" ? "cancelled" : r.outcome;

    const [closed] = await tx
      .update(dispatches)
      .set({
        status: outcome,
        exitCode: r.exitCode,
        executionId: r.executionId,
        error: r.errorMessage,
        finishedAt: new Date(),
      })
      .where(eq(dispatches.id, d.id))
      .returning();
    outbox.add((c) => c.hub.toProject(d.projectId, "dispatch:updated", dispatchDTO(closed!)));
    await cancelPendingApprovals(tx, outbox, d.id, "The run ended before a decision");

    const { row: agent, ref } = await agentRef(tx, agentId);
    const git = r.observed.git;
    const filesChanged = git?.changedFiles ?? [];
    let body = r.finalText.trim();
    if (outcome === "failed") body = body ? `${body}\n\nRun failed: ${r.errorMessage ?? "unknown error"}` : `Run failed: ${r.errorMessage ?? "unknown error"}`;
    if (outcome === "cancelled") body = body ? `${body}\n\n(Run cancelled.)` : "Run cancelled before completion.";
    if (!body) body = "The agent finished without a text reply.";

    await insertMessage(tx, outbox, {
      projectId: d.projectId,
      kind: "agent",
      authorType: "agent",
      authorAgentId: agentId,
      body,
      replyToId: d.messageId,
      dispatchId: d.id,
      taskId: d.taskId,
      meta: {
        outcome,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        provider: agent.provider,
        commands: r.observed.commands.slice(0, 30),
        filesChanged: filesChanged.slice(0, 100),
        branch: git?.branch ?? null,
        head: git?.head ?? null,
        baseCommit: r.observed.baseCommit,
        baseCheck: r.observed.baseCheck,
        hasDiff: !!r.observed.diff,
        reported: r.reported,
        late,
      },
    });
    await tx
      .update(agents)
      .set({ lastEvent: `Run ${outcome}`, lastEventAt: new Date(), ...(git ? { repo: git } : {}) })
      .where(eq(agents.id, agentId));

    if (d.taskId) {
      const t = await lockTask(tx, d.taskId);
      if (t) {
        const handoff: Handoff = {
          objective: [t.title, t.description].filter(Boolean).join("\n\n"),
          acceptanceCriteria: t.acceptanceCriteria,
          observed: {
            filesChanged,
            commands: r.observed.commands,
            branch: git?.branch ?? null,
            baseCommit: r.observed.baseCommit,
            headCommit: git?.head ?? null,
            exitCode: r.exitCode,
            provider: agent.provider,
            executionId: r.executionId,
          },
          reported: r.reported,
        };
        await tx.insert(handoffs).values({
          projectId: d.projectId,
          taskId: t.id,
          dispatchId: d.id,
          fromType: "agent",
          fromId: agentId,
          fromName: agent.displayName,
          note: late ? "Result arrived after the run was marked interrupted." : "",
          data: handoff,
          diff: r.observed.diff,
          diffTruncated: r.observed.diffTruncated,
        });
        const patch = {
          branch: git?.branch ?? t.branch,
          commit: git?.head ?? t.commit,
          lastResult: (r.reported?.summary || r.finalText).slice(0, 2000) || null,
        };
        if (t.status === "running" && t.assigneeAgentId === agentId) {
          const hasResult = !!r.finalText.trim() || !!r.reported;
          if (outcome === "succeeded" && hasResult)
            await applyTransition(tx, outbox, t, "awaiting_review", "agent", ref, "Run finished; awaiting human review", patch);
          else if (outcome === "succeeded")
            await applyTransition(tx, outbox, t, "blocked", "system", ref, "Run exited cleanly but reported no result", patch);
          else if (outcome === "failed")
            await applyTransition(tx, outbox, t, "failed", "agent", ref, r.errorMessage ?? "Run failed", patch);
          else await applyTransition(tx, outbox, t, "blocked", "system", ref, "Run cancelled", patch);
        } else {
          await tx.update(tasks).set({ ...patch, updatedAt: new Date() }).where(eq(tasks.id, t.id));
        }
      }
    }

    // Agent-proposed decisions and questions are stored as suggestions, never as verified memory.
    const proposals = [
      ...(r.reported?.decisions ?? []).map((text) => ({ kind: "decision" as const, status: "suggested" as const, text })),
      ...(r.reported?.openQuestions ?? []).map((text) => ({ kind: "open_question" as const, status: "assumption" as const, text })),
    ];
    for (const p of proposals) {
      const [m] = await tx
        .insert(memoryEntries)
        .values({
          projectId: d.projectId,
          kind: p.kind,
          title: p.text.slice(0, 300),
          body: p.text,
          status: p.status,
          sourceType: "agent",
          sourceId: agentId,
          sourceName: agent.displayName,
          taskId: d.taskId,
          messageId: null,
        })
        .returning();
      outbox.add((c) => c.hub.toProject(d.projectId, "memory:updated", memoryDTO(m!)));
    }

    if (r.observed.baseCheck && !r.observed.baseCheck.isAncestorOfHead) {
      await postSystemMessage(
        tx,
        outbox,
        d.projectId,
        `Stale base warning: ${agent.displayName}'s checkout ${
          r.observed.baseCheck.present ? "does not build on" : "does not contain"
        } commit ${r.observed.baseCheck.expectedCommit.slice(0, 12)} from the previous handoff.`,
        { dispatchId: d.id, taskId: d.taskId, meta: { notice: "stale_base" } },
      );
    }
    if (git && git.behind && git.behind > 0) {
      await postSystemMessage(
        tx,
        outbox,
        d.projectId,
        `${agent.displayName}'s branch ${git.branch ?? ""} is ${git.behind} commit(s) behind ${git.upstream ?? "its upstream"}.`,
        { dispatchId: d.id, taskId: d.taskId, meta: { notice: "behind_upstream" } },
      );
    }
    for (const o of await overlappingChanges(tx, d.projectId, agentId, git)) {
      await postSystemMessage(
        tx,
        outbox,
        d.projectId,
        `Possible conflict: ${agent.displayName} and @${o.handle} both have uncommitted changes to ${o.files
          .slice(0, 5)
          .join(", ")}${o.files.length > 5 ? ` and ${o.files.length - 5} more` : ""}.`,
        { dispatchId: d.id, taskId: d.taskId, meta: { notice: "conflict_risk", files: o.files.slice(0, 50) } },
      );
    }
    outbox.add((c) => broadcastAgent(c, agentId));
    return { ok: true };
  });
  await outbox.flush(ctx);
  await pumpAgent(ctx, agentId);
  return res;
}

/** Human cancels a dispatch. Pending ones are cancelled outright; running ones are signalled to the adapter. */
export async function cancelDispatch(ctx: Ctx, user: UserDTO, dispatchId: string) {
  const [d0] = await ctx.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!d0) throw notFound("Dispatch not found");
  await requireMember(ctx.db, d0.projectId, user.id);
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, d0.agentId));
  if (d0.requestedBy !== user.id && agent?.ownerId !== user.id) {
    const [p] = await ctx.db.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, d0.projectId));
    if (p?.ownerId !== user.id) throw forbidden("Only the requester, the agent owner or the project owner can cancel");
  }
  const outbox = new Outbox();
  const result = await ctx.db.transaction(async (tx) => {
    const [d] = await tx.select().from(dispatches).where(eq(dispatches.id, dispatchId)).for("update");
    if (!d) throw notFound("Dispatch not found");
    const by = { type: "user" as const, id: user.id, name: user.displayName };
    if (d.status === "pending") {
      const [c] = await tx
        .update(dispatches)
        .set({ status: "cancelled", cancelRequested: true, finishedAt: new Date(), error: `Cancelled by ${user.displayName}` })
        .where(eq(dispatches.id, d.id))
        .returning();
      outbox.add((x) => x.hub.toProject(d.projectId, "dispatch:updated", dispatchDTO(c!)));
      await postSystemMessage(tx, outbox, d.projectId, `${user.displayName} cancelled a queued request before it started.`, {
        replyToId: d.messageId,
        dispatchId: d.id,
        taskId: d.taskId,
      });
      if (d.taskId) {
        const t = await lockTask(tx, d.taskId);
        if (t && t.status === "assigned") await applyTransition(tx, outbox, t, "blocked", "human", by, "Queued run cancelled");
      }
      return { status: "cancelled" as const, signalled: false };
    }
    if (d.status === "running") {
      await tx.update(dispatches).set({ cancelRequested: true }).where(eq(dispatches.id, d.id));
      await cancelPendingApprovals(tx, outbox, d.id, `Run cancellation requested by ${user.displayName}`, true);
      await postSystemMessage(tx, outbox, d.projectId, `${user.displayName} requested cancellation of a running request.`, {
        dispatchId: d.id,
        taskId: d.taskId,
      });
      return { status: "cancel_requested" as const, signalled: true };
    }
    throw conflict(`Dispatch is already ${d.status}`);
  });
  await outbox.flush(ctx);
  if (result.signalled && !ctx.hub.cancelDispatch(d0.agentId, dispatchId)) {
    return { status: "cancel_requested" as const, note: "Adapter is offline; it will be told when it reconnects." };
  }
  if (!result.signalled) await pumpAgent(ctx, d0.agentId);
  return { status: result.status };
}

/** A human re-runs a failed/interrupted/rejected/cancelled mention dispatch as a new dispatch. */
export async function retryDispatch(ctx: Ctx, user: UserDTO, dispatchId: string, confirmConcurrent: boolean) {
  const [d] = await ctx.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!d) throw notFound("Dispatch not found");
  await requireMember(ctx.db, d.projectId, user.id);
  if (!["failed", "interrupted", "rejected", "cancelled"].includes(d.status)) throw conflict(`Dispatch is ${d.status}`);
  if (d.taskId) throw badRequest("Re-run task work by assigning the task again");
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, d.agentId));
  if (!agent) throw notFound("Agent not found");
  const reason = await agentAvailability(ctx, agent, user, d.permission);
  if (reason) throw conflict(`@${agent.handle} cannot take this: ${reason}`);
  if (!confirmConcurrent) {
    const reasons = await concurrencyWarnings(ctx.db, d.projectId, agent, d.permission);
    if (reasons.length) return { needsConfirmation: { reasons } };
  }
  const outbox = new Outbox();
  const nd = await ctx.db.transaction(async (tx) => {
    await postSystemMessage(tx, outbox, d.projectId, `${user.displayName} re-ran the request for @${agent.handle}.`, {
      replyToId: d.messageId,
    });
    return createDispatch(tx, outbox, {
      projectId: d.projectId,
      agent,
      requester: user,
      kind: d.kind,
      instruction: d.instruction,
      taskId: null,
      messageId: d.messageId,
      permission: d.permission,
      idempotencyKey: `retry:${d.id}:${Date.now()}`,
    });
  });
  await outbox.flush(ctx);
  await pumpAgent(ctx, agent.id);
  return { dispatch: dispatchDTO(nd) };
}

/**
 * Marks running dispatches as interrupted. Used when an adapter reconnects without them (its process
 * restarted) and by the sweeper for adapters that stayed away past the grace period.
 * Interrupted work is never re-run automatically.
 */
export async function interruptDispatches(ctx: Ctx, agentId: string, keepIds: string[], reason: string): Promise<number> {
  const outbox = new Outbox();
  const n = await ctx.db.transaction(async (tx) => {
    const conds = [eq(dispatches.agentId, agentId), eq(dispatches.status, "running")];
    if (keepIds.length) conds.push(notInArray(dispatches.id, keepIds));
    const rows = await tx
      .update(dispatches)
      .set({ status: "interrupted", error: reason, finishedAt: new Date() })
      .where(and(...conds))
      .returning();
    if (!rows.length) return 0;
    const { ref } = await agentRef(tx, agentId);
    for (const d of rows) {
      outbox.add((c) => c.hub.toProject(d.projectId, "dispatch:updated", dispatchDTO(d)));
      await cancelPendingApprovals(tx, outbox, d.id, "The run was interrupted");
      await postSystemMessage(
        tx,
        outbox,
        d.projectId,
        `${ref.name}'s run was interrupted (${reason}). It will not be re-run automatically; retry it if needed.`,
        { replyToId: d.messageId, dispatchId: d.id, taskId: d.taskId, meta: { notice: "run_interrupted" } },
      );
      if (d.taskId) {
        const t = await lockTask(tx, d.taskId);
        if (t && t.status === "running") await applyTransition(tx, outbox, t, "blocked", "system", ref, `Run interrupted: ${reason}`);
      }
    }
    return rows.length;
  });
  await outbox.flush(ctx);
  return n;
}

/** Periodic maintenance: stale heartbeats → offline, long-orphaned runs → interrupted. */
export async function sweep(ctx: Ctx): Promise<void> {
  const staleBefore = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS);
  const stale = await ctx.db
    .update(agents)
    .set({ connected: false })
    .where(and(eq(agents.connected, true), lt(agents.lastHeartbeatAt, staleBefore)))
    .returning({ id: agents.id });
  for (const a of stale) {
    ctx.hub.disconnectAgent(a.id, "heartbeat timeout");
    await broadcastAgent(ctx, a.id);
  }
  const orphanBefore = new Date(Date.now() - ctx.config.orphanGraceMs);
  const orphans = await ctx.db
    .selectDistinct({ agentId: dispatches.agentId })
    .from(dispatches)
    .innerJoin(agents, eq(agents.id, dispatches.agentId))
    .where(
      and(
        eq(dispatches.status, "running"),
        eq(agents.connected, false),
        sql`coalesce(${agents.lastHeartbeatAt}, ${dispatches.startedAt}) < ${orphanBefore}`,
      ),
    );
  for (const o of orphans) await interruptDispatches(ctx, o.agentId, [], "adapter offline for too long");
  await expireDueApprovals(ctx);
}
