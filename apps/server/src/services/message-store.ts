import { eq } from "drizzle-orm";
import type { MessageDTO } from "@relayroom/protocol";
import type { Outbox as OutboxT } from "./ctx.js";
import type { DbOrTx } from "../db/client.js";
import { agents, messages, users } from "../db/schema.js";
import { messageDTO } from "./serialize.js";

export type NewMessage = typeof messages.$inferInsert;

/** Inserts a message and queues its broadcast for after commit. */
export async function insertMessage(db: DbOrTx, outbox: OutboxT, values: NewMessage): Promise<MessageDTO> {
  const [m] = await db.insert(messages).values(values).returning();
  let userName: string | null = null;
  let agentName: string | null = null;
  if (m!.authorUserId) {
    const [u] = await db.select({ n: users.displayName }).from(users).where(eq(users.id, m!.authorUserId));
    userName = u?.n ?? null;
  }
  if (m!.authorAgentId) {
    const [a] = await db.select({ n: agents.displayName }).from(agents).where(eq(agents.id, m!.authorAgentId));
    agentName = a?.n ?? null;
  }
  const dto = messageDTO(m!, { userName, agentName });
  outbox.add((ctx) => ctx.hub.toProject(dto.projectId, "message:new", dto));
  return dto;
}

export function postSystemMessage(
  db: DbOrTx,
  outbox: OutboxT,
  projectId: string,
  body: string,
  extra: Partial<NewMessage> = {},
): Promise<MessageDTO> {
  return insertMessage(db, outbox, { projectId, kind: "system", authorType: "system", body, ...extra });
}

