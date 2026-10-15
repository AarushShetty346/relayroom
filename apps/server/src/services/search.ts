import { and, desc, eq, ilike, or } from "drizzle-orm";
import type { UserDTO } from "@relayroom/protocol";
import type { Ctx } from "./ctx.js";
import { agents, memoryEntries, messages, tasks, users } from "../db/schema.js";
import { requireMember } from "./projects.js";
import { memoryDTO, messageDTO } from "./serialize.js";
import { loadTaskDTO } from "./task-state.js";

/** Case-insensitive substring search across a project's messages, tasks and memory. */
export async function searchProject(ctx: Ctx, user: UserDTO, projectId: string, q: string) {
  await requireMember(ctx.db, projectId, user.id);
  const pattern = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  const msgRows = await ctx.db
    .select({ m: messages, userName: users.displayName, agentName: agents.displayName })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(and(eq(messages.projectId, projectId), ilike(messages.body, pattern)))
    .orderBy(desc(messages.seq))
    .limit(30);
  const taskRows = await ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), or(ilike(tasks.title, pattern), ilike(tasks.description, pattern))))
    .orderBy(desc(tasks.number))
    .limit(20);
  const memRows = await ctx.db
    .select()
    .from(memoryEntries)
    .where(and(eq(memoryEntries.projectId, projectId), or(ilike(memoryEntries.title, pattern), ilike(memoryEntries.body, pattern))))
    .limit(20);
  return {
    messages: msgRows.map((r) => messageDTO(r.m, { userName: r.userName, agentName: r.agentName })),
    tasks: await Promise.all(taskRows.map((t) => loadTaskDTO(ctx.db, t))),
    memory: memRows.map(memoryDTO),
  };
}
