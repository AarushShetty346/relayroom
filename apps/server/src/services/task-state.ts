import { and, eq } from "drizzle-orm";
import { canTransition, type ActorRef, type TaskDTO, type TaskStatus, type TransitionActor } from "@relayroom/protocol";
import type { Outbox } from "./ctx.js";
import type { DbOrTx } from "../db/client.js";
import { agents, messages, taskEvents, tasks, users } from "../db/schema.js";
import { conflict } from "../lib/errors.js";
import { taskDTO } from "./serialize.js";

export type TaskRow = typeof tasks.$inferSelect;

export async function loadTaskDTO(db: DbOrTx, t: TaskRow): Promise<TaskDTO> {
  let name: string | null = null;
  if (t.assigneeAgentId) {
    const [a] = await db.select({ n: agents.displayName }).from(agents).where(eq(agents.id, t.assigneeAgentId));
    name = a?.n ?? null;
  } else if (t.assigneeUserId) {
    const [u] = await db.select({ n: users.displayName }).from(users).where(eq(users.id, t.assigneeUserId));
    name = u?.n ?? null;
  }
  const related = await db.select({ id: messages.id }).from(messages).where(eq(messages.taskId, t.id));
  return taskDTO(t, name, related.map((r) => r.id));
}

export function broadcastTask(db: DbOrTx, outbox: Outbox, t: TaskRow): void {
  // Resolve the DTO at flush time so it reflects committed state.
  outbox.add(async (ctx) => ctx.hub.toProject(t.projectId, "task:updated", await loadTaskDTO(ctx.db, t)));
}

/**
 * The only way task status changes. Validates the transition against the shared state machine for
 * the acting party, applies it with an optimistic check on the current status, records history.
 */
export async function applyTransition(
  db: DbOrTx,
  outbox: Outbox,
  task: TaskRow,
  to: TaskStatus,
  actor: TransitionActor,
  by: ActorRef,
  note: string,
  patch: Partial<typeof tasks.$inferInsert> = {},
): Promise<TaskRow> {
  if (!canTransition(task.status, to, actor)) {
    throw conflict(`Task #${task.number} cannot move from ${task.status} to ${to} (${actor})`);
  }
  const [updated] = await db
    .update(tasks)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
    .returning();
  if (!updated) throw conflict("Task changed concurrently; reload and try again");
  await db.insert(taskEvents).values({
    taskId: task.id,
    fromStatus: task.status,
    toStatus: to,
    actorType: by.type,
    actorId: by.id,
    actorName: by.name,
    note,
  });
  outbox.add(async (ctx) => {
    const [fresh] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.id));
    if (fresh) ctx.hub.toProject(fresh.projectId, "task:updated", await loadTaskDTO(ctx.db, fresh));
  });
  return updated;
}

/** Locks the task row for the rest of the transaction. */
export async function lockTask(db: DbOrTx, taskId: string): Promise<TaskRow | undefined> {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
  return t;
}
