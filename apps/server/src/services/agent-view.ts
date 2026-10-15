import { and, eq, inArray } from "drizzle-orm";
import type { AgentDTO } from "@relayroom/protocol";
import type { Ctx } from "./ctx.js";
import type { DbOrTx } from "../db/client.js";
import { agents, dispatches, users } from "../db/schema.js";
import { agentDTO } from "./serialize.js";

type AgentRow = typeof agents.$inferSelect;

export async function agentDTOs(db: DbOrTx, rows: AgentRow[], liveIds?: Set<string>): Promise<AgentDTO[]> {
  if (!rows.length) return [];
  const ids = rows.map((a) => a.id);
  const owners = await db
    .select({ id: users.id, name: users.displayName })
    .from(users)
    .where(inArray(users.id, [...new Set(rows.map((a) => a.ownerId))]));
  const running = await db
    .select({ id: dispatches.id, agentId: dispatches.agentId, taskId: dispatches.taskId })
    .from(dispatches)
    .where(and(inArray(dispatches.agentId, ids), eq(dispatches.status, "running")));
  return rows.map((a) => {
    const r = running.find((x) => x.agentId === a.id);
    // The DB flag can lag a server restart; the live socket map is authoritative when provided.
    const row = liveIds && !liveIds.has(a.id) ? { ...a, connected: false } : a;
    return agentDTO(row, {
      ownerName: owners.find((o) => o.id === a.ownerId)?.name ?? "unknown",
      activeDispatchId: r?.id ?? null,
      activeTaskId: r?.taskId ?? null,
    });
  });
}

export async function broadcastAgent(ctx: Ctx, agentId: string): Promise<void> {
  const [a] = await ctx.db.select().from(agents).where(eq(agents.id, agentId));
  if (!a) return;
  const live = ctx.hub.isAgentConnected(a.id) ? new Set([a.id]) : new Set<string>();
  const [dto] = await agentDTOs(ctx.db, [a], live);
  ctx.hub.toProject(a.projectId, "agent:updated", dto!);
}
