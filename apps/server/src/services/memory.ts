import { and, desc, eq } from "drizzle-orm";
import type { MemoryDTO, MemoryKind, MemoryStatus, UserDTO } from "@relayroom/protocol";
import type { Ctx } from "./ctx.js";
import { memoryEntries, messages, tasks } from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { requireMember } from "./projects.js";
import { memoryDTO } from "./serialize.js";

export async function listMemory(ctx: Ctx, user: UserDTO, projectId: string): Promise<MemoryDTO[]> {
  await requireMember(ctx.db, projectId, user.id);
  const rows = await ctx.db
    .select()
    .from(memoryEntries)
    .where(eq(memoryEntries.projectId, projectId))
    .orderBy(desc(memoryEntries.updatedAt))
    .limit(500);
  return rows.map(memoryDTO);
}

async function checkRefs(ctx: Ctx, projectId: string, taskId: string | null, messageId: string | null) {
  if (taskId) {
    const [t] = await ctx.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
    if (!t) throw badRequest("taskId is not a task in this project");
  }
  if (messageId) {
    const [m] = await ctx.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.projectId, projectId)));
    if (!m) throw badRequest("messageId is not a message in this project");
  }
}

/** Entries written by humans. Humans may record verified facts directly. */
export async function createMemory(
  ctx: Ctx,
  user: UserDTO,
  projectId: string,
  input: { kind: MemoryKind; title: string; body: string; status: MemoryStatus; taskId: string | null; messageId: string | null },
): Promise<MemoryDTO> {
  await requireMember(ctx.db, projectId, user.id);
  await checkRefs(ctx, projectId, input.taskId, input.messageId);
  const [m] = await ctx.db
    .insert(memoryEntries)
    .values({
      projectId,
      ...input,
      sourceType: "user",
      sourceId: user.id,
      sourceName: user.displayName,
      verifiedBy: input.status === "verified" ? user.id : null,
    })
    .returning();
  const dto = memoryDTO(m!);
  ctx.hub.toProject(projectId, "memory:updated", dto);
  return dto;
}

/** Humans correct entries or promote agent suggestions to verified. */
export async function updateMemory(
  ctx: Ctx,
  user: UserDTO,
  id: string,
  patch: { kind?: MemoryKind; title?: string; body?: string; status?: MemoryStatus },
): Promise<MemoryDTO> {
  const [cur] = await ctx.db.select().from(memoryEntries).where(eq(memoryEntries.id, id));
  if (!cur) throw notFound("Memory entry not found");
  await requireMember(ctx.db, cur.projectId, user.id);
  const verifiedBy = patch.status === undefined ? cur.verifiedBy : patch.status === "verified" ? user.id : null;
  const [m] = await ctx.db
    .update(memoryEntries)
    .set({ ...patch, verifiedBy, updatedAt: new Date() })
    .where(eq(memoryEntries.id, id))
    .returning();
  const dto = memoryDTO(m!);
  ctx.hub.toProject(cur.projectId, "memory:updated", dto);
  return dto;
}

export async function deleteMemory(ctx: Ctx, user: UserDTO, id: string): Promise<void> {
  const [cur] = await ctx.db.select().from(memoryEntries).where(eq(memoryEntries.id, id));
  if (!cur) throw notFound("Memory entry not found");
  await requireMember(ctx.db, cur.projectId, user.id);
  await ctx.db.delete(memoryEntries).where(eq(memoryEntries.id, id));
  ctx.hub.toProject(cur.projectId, "memory:updated", { id, deleted: true });
}
