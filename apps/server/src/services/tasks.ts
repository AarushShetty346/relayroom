import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  HANDOFF_INSTRUCTIONS,
  type AssigneeRef,
  type Handoff,
  type PermissionProfile,
  type TaskDetailDTO,
  type TaskDTO,
  type TaskStatus,
  type UserDTO,
} from "@relayroom/protocol";
import type { Ctx } from "./ctx.js";
import { Outbox } from "./ctx.js";
import { agents, dispatches, handoffs, messages, projectMembers, projects, taskEvents, tasks, users } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { requireMember } from "./projects.js";
import { insertMessage } from "./message-store.js";
import { agentAvailability, concurrencyWarnings, createDispatch, pumpAgent } from "./dispatch.js";
import { dispatchDTO, handoffDTO } from "./serialize.js";
import { applyTransition, broadcastTask, loadTaskDTO, lockTask, type TaskRow } from "./task-state.js";

async function requireTask(ctx: Ctx, user: UserDTO, taskId: string): Promise<TaskRow> {
  const [t] = await ctx.db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) throw notFound("Task not found");
  await requireMember(ctx.db, t.projectId, user.id);
  return t;
}

export async function createTask(
  ctx: Ctx,
  user: UserDTO,
  projectId: string,
  input: { title: string; description: string; acceptanceCriteria: string[]; sourceMessageId: string | null },
): Promise<TaskDTO> {
  await requireMember(ctx.db, projectId, user.id);
  const outbox = new Outbox();
  const t = await ctx.db.transaction(async (tx) => {
    if (input.sourceMessageId) {
      const [m] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, input.sourceMessageId), eq(messages.projectId, projectId)));
      if (!m) throw badRequest("sourceMessageId is not a message in this project");
    }
    const [p] = await tx
      .update(projects)
      .set({ taskCounter: sql`${projects.taskCounter} + 1` })
      .where(eq(projects.id, projectId))
      .returning({ n: projects.taskCounter });
    const [t] = await tx
      .insert(tasks)
      .values({ projectId, number: p!.n, createdBy: user.id, ...input })
      .returning();
    await tx.insert(taskEvents).values({
      taskId: t!.id,
      fromStatus: null,
      toStatus: "queued",
      actorType: "user",
      actorId: user.id,
      actorName: user.displayName,
      note: "Created",
    });
    if (input.sourceMessageId) await tx.update(messages).set({ taskId: t!.id }).where(eq(messages.id, input.sourceMessageId));
    await insertMessage(tx, outbox, {
      projectId,
      kind: "task",
      authorType: "user",
      authorUserId: user.id,
      body: `created task #${t!.number}: ${t!.title}`,
      taskId: t!.id,
      meta: { event: "task_created" },
    });
    broadcastTask(tx, outbox, t!);
    return t!;
  });
  await outbox.flush(ctx);
  return loadTaskDTO(ctx.db, t);
}

export async function listTasks(ctx: Ctx, user: UserDTO, projectId: string): Promise<TaskDTO[]> {
  await requireMember(ctx.db, projectId, user.id);
  const rows = await ctx.db.select().from(tasks).where(eq(tasks.projectId, projectId)).orderBy(desc(tasks.number));
  return Promise.all(rows.map((t) => loadTaskDTO(ctx.db, t)));
}

export async function getTaskDetail(ctx: Ctx, user: UserDTO, taskId: string): Promise<TaskDetailDTO> {
  const t = await requireTask(ctx, user, taskId);
  const hs = await ctx.db.select().from(handoffs).where(eq(handoffs.taskId, taskId)).orderBy(asc(handoffs.createdAt));
  const ds = await ctx.db.select().from(dispatches).where(eq(dispatches.taskId, taskId)).orderBy(asc(dispatches.createdAt));
  const ev = await ctx.db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(asc(taskEvents.createdAt));
  return {
    task: await loadTaskDTO(ctx.db, t),
    handoffs: hs.map(handoffDTO),
    dispatches: ds.map(dispatchDTO),
    history: ev.map((e) => ({
      at: e.createdAt.toISOString(),
      from: e.fromStatus,
      to: e.toStatus,
      by: { type: e.actorType, id: e.actorId, name: e.actorName },
      note: e.note,
    })),
  };
}

export async function updateTask(
  ctx: Ctx,
  user: UserDTO,
  taskId: string,
  patch: { title?: string; description?: string; acceptanceCriteria?: string[] },
): Promise<TaskDTO> {
  const t = await requireTask(ctx, user, taskId);
  if (t.status === "completed" || t.status === "cancelled") throw conflict("Closed tasks cannot be edited");
  const [u] = await ctx.db.update(tasks).set({ ...patch, updatedAt: new Date() }).where(eq(tasks.id, taskId)).returning();
  const dto = await loadTaskDTO(ctx.db, u!);
  ctx.hub.toProject(u!.projectId, "task:updated", dto);
  return dto;
}

function taskInstruction(t: TaskRow, note: string): string {
  const lines = [`Task #${t.number}: ${t.title}`];
  if (t.description) lines.push("", t.description);
  if (t.acceptanceCriteria.length) {
    lines.push("", "Acceptance criteria:");
    for (const c of t.acceptanceCriteria) lines.push(`- ${c}`);
  }
  if (note) lines.push("", `Note from the assigner: ${note}`);
  lines.push("", HANDOFF_INSTRUCTIONS);
  return lines.join("\n");
}

/**
 * Assigns (or reassigns) a task. Assigning to an agent with start=true dispatches it. Moving a task
 * that already has handoffs to a different assignee records a transfer handoff, so the receiver gets
 * the previous agent's state.
 */
export async function assignTask(
  ctx: Ctx,
  user: UserDTO,
  taskId: string,
  input: { assignee: AssigneeRef | null; start: boolean; permission: PermissionProfile; note: string; confirmConcurrent: boolean },
): Promise<{ task?: TaskDTO; needsConfirmation?: { reasons: string[] }; dispatchId?: string }> {
  const t0 = await requireTask(ctx, user, taskId);
  const by = { type: "user" as const, id: user.id, name: user.displayName };
  let agent: typeof agents.$inferSelect | undefined;
  let assigneeName = "nobody";

  if (input.assignee?.type === "agent") {
    [agent] = await ctx.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.assignee.id), eq(agents.projectId, t0.projectId)));
    if (!agent || agent.revokedAt) throw badRequest("That agent is not registered in this project");
    assigneeName = `@${agent.handle}`;
    if (input.start) {
      const reason = await agentAvailability(ctx, agent, user, input.permission);
      if (reason) throw conflict(`@${agent.handle} cannot take this task: ${reason}`);
      if (!input.confirmConcurrent) {
        const reasons = await concurrencyWarnings(ctx.db, t0.projectId, agent, input.permission);
        if (reasons.length) return { needsConfirmation: { reasons } };
      }
    }
  } else if (input.assignee?.type === "user") {
    const [m] = await ctx.db
      .select({ name: users.displayName, username: users.username })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(and(eq(projectMembers.projectId, t0.projectId), eq(projectMembers.userId, input.assignee.id)));
    if (!m) throw badRequest("That user is not a member of this project");
    assigneeName = `@${m.username}`;
  }

  const outbox = new Outbox();
  const res = await ctx.db.transaction(async (tx) => {
    const t = await lockTask(tx, taskId);
    if (!t) throw notFound("Task not found");
    if (t.status === "running") throw conflict("The task is running; cancel the run before reassigning it");
    // One active run per task: a queued (not yet accepted) run must be cancelled before another starts.
    const active = await tx
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(and(eq(dispatches.taskId, t.id), inArray(dispatches.status, ["pending", "running"])));
    if (active.length) throw conflict("The task already has a queued run; cancel it before reassigning");
    const prevAgentId = t.assigneeAgentId;
    const prevUserId = t.assigneeUserId;
    const patch = {
      assigneeAgentId: input.assignee?.type === "agent" ? input.assignee.id : null,
      assigneeUserId: input.assignee?.type === "user" ? input.assignee.id : null,
    };
    const to: TaskStatus = input.assignee ? "assigned" : "queued";
    const moved = await applyTransition(tx, outbox, t, to, "human", by, input.note || `Assigned to ${assigneeName}`, patch);

    // Transfer: the task changes hands after earlier work. Record a handoff to the new assignee.
    const changedHands =
      (prevAgentId && prevAgentId !== patch.assigneeAgentId) || (prevUserId && prevUserId !== patch.assigneeUserId);
    if (changedHands && input.assignee) {
      const [last] = await tx
        .select()
        .from(handoffs)
        .where(eq(handoffs.taskId, t.id))
        .orderBy(desc(handoffs.createdAt))
        .limit(1);
      if (last) {
        await tx.insert(handoffs).values({
          projectId: t.projectId,
          taskId: t.id,
          fromType: "user",
          fromId: user.id,
          fromName: user.displayName,
          toType: input.assignee.type,
          toId: input.assignee.id,
          toName: assigneeName,
          note: input.note || `Transferred from ${last.fromName} to ${assigneeName}`,
          data: last.data as Handoff,
          diff: last.diff,
          diffTruncated: last.diffTruncated,
        });
      }
    }

    const message = await insertMessage(tx, outbox, {
      projectId: t.projectId,
      kind: "task",
      authorType: "user",
      authorUserId: user.id,
      body: input.assignee
        ? `assigned task #${t.number} "${t.title}" to ${assigneeName}${agent && input.start ? ` (${input.permission})` : ""}${input.note ? ` — ${input.note}` : ""}`
        : `unassigned task #${t.number} "${t.title}"`,
      taskId: t.id,
      mentions: agent ? [{ type: "agent", id: agent.id, handle: agent.handle }] : [],
      meta: { event: "task_assigned" },
    });

    let dispatchId: string | undefined;
    if (agent && input.start) {
      const d = await createDispatch(tx, outbox, {
        projectId: t.projectId,
        agent,
        requester: user,
        kind: "task",
        instruction: taskInstruction(moved, input.note),
        taskId: t.id,
        messageId: message.id,
        permission: input.permission,
        idempotencyKey: `task:${t.id}:${message.id}`,
      });
      dispatchId = d.id;
    }
    return { task: moved, dispatchId };
  });
  await outbox.flush(ctx);
  if (agent && res.dispatchId) await pumpAgent(ctx, agent.id);
  return { task: await loadTaskDTO(ctx.db, res.task), ...(res.dispatchId ? { dispatchId: res.dispatchId } : {}) };
}

/** Human-driven status change (review decisions, blocking, cancelling, marking own work started). */
export async function transitionTask(ctx: Ctx, user: UserDTO, taskId: string, input: { to: TaskStatus; note: string }) {
  const t0 = await requireTask(ctx, user, taskId);
  if (input.to === "running" && t0.assigneeAgentId)
    throw conflict("Agent tasks start running when the agent's adapter accepts the work");
  if (input.to === "assigned") throw badRequest("Use the assign endpoint to assign or re-run a task");
  const outbox = new Outbox();
  const t = await ctx.db.transaction(async (tx) => {
    const t = await lockTask(tx, taskId);
    if (!t) throw notFound("Task not found");
    if (input.to === "cancelled" && t.status === "running") {
      throw conflict("Cancel the running dispatch first");
    }
    const by = { type: "user" as const, id: user.id, name: user.displayName };
    const moved = await applyTransition(tx, outbox, t, input.to, "human", by, input.note);
    await insertMessage(tx, outbox, {
      projectId: t.projectId,
      kind: "task",
      authorType: "user",
      authorUserId: user.id,
      body: `moved task #${t.number} from ${t.status} to ${input.to}${input.note ? ` — ${input.note}` : ""}`,
      taskId: t.id,
      meta: { event: "task_transition", from: t.status, to: input.to },
    });
    return moved;
  });
  await outbox.flush(ctx);
  return loadTaskDTO(ctx.db, t);
}

/** Latest handoffs across the project, for the context panel. Diffs are omitted (fetch the task). */
export async function recentHandoffs(ctx: Ctx, user: UserDTO, projectId: string) {
  await requireMember(ctx.db, projectId, user.id);
  const rows = await ctx.db
    .select({ h: handoffs, number: tasks.number, title: tasks.title })
    .from(handoffs)
    .innerJoin(tasks, eq(tasks.id, handoffs.taskId))
    .where(eq(handoffs.projectId, projectId))
    .orderBy(desc(handoffs.createdAt))
    .limit(15);
  return rows.map((r) => ({ ...handoffDTO({ ...r.h, diff: null }), taskNumber: r.number, taskTitle: r.title }));
}
