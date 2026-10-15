import { and, asc, desc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import {
  extractMentions,
  stripLeadingMentions,
  type MentionDTO,
  type MessageDTO,
  type PermissionProfile,
  type SendMessageResult,
  type UserDTO,
} from "@relayroom/protocol";
import type { Ctx } from "./ctx.js";
import { Outbox } from "./ctx.js";
import type { DbOrTx } from "../db/client.js";
import { agents, dispatches, messages, projectMembers, users } from "../db/schema.js";
import { badRequest } from "../lib/errors.js";
import { isUniqueViolation } from "../lib/pg-errors.js";
import { messageDTO, dispatchDTO } from "./serialize.js";
import { insertMessage, postSystemMessage } from "./message-store.js";
import { requireMember } from "./projects.js";
import { agentAvailability, concurrencyWarnings, createDispatch, pumpAgent } from "./dispatch.js";

async function hydrate(db: DbOrTx, where: ReturnType<typeof and>, order: "asc" | "desc", limit: number) {
  const rows = await db
    .select({ m: messages, userName: users.displayName, agentName: agents.displayName })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(where)
    .orderBy(order === "asc" ? asc(messages.seq) : desc(messages.seq))
    .limit(limit);
  return rows.map((r) => messageDTO(r.m, { userName: r.userName, agentName: r.agentName }));
}

/**
 * Cursor pagination over the monotonic seq. `after` is used to catch up after a reconnect;
 * `before` loads older history. Returned in ascending order.
 */
export async function listMessages(
  ctx: Ctx,
  user: UserDTO,
  projectId: string,
  q: { before?: string; after?: string; limit: number; taskId?: string },
): Promise<{ messages: MessageDTO[]; hasMore: boolean }> {
  await requireMember(ctx.db, projectId, user.id);
  const limit = Math.min(Math.max(q.limit, 1), 200);
  const conds = [eq(messages.projectId, projectId)];
  if (q.taskId) conds.push(eq(messages.taskId, q.taskId));
  const parse = (s: string) => {
    if (!/^\d{1,19}$/.test(s)) throw badRequest("Invalid cursor");
    return BigInt(s);
  };
  if (q.after !== undefined) {
    const rows = await hydrate(ctx.db, and(...conds, gt(messages.seq, parse(q.after))), "asc", limit + 1);
    return { messages: rows.slice(0, limit), hasMore: rows.length > limit };
  }
  if (q.before !== undefined) conds.push(lt(messages.seq, parse(q.before)));
  const rows = await hydrate(ctx.db, and(...conds), "desc", limit + 1);
  return { messages: rows.slice(0, limit).reverse(), hasMore: rows.length > limit };
}

/**
 * Posts a human message. @mentions of registered agents create dispatches (and nothing else wakes an
 * agent). Idempotent on clientNonce: a retried POST returns the original message.
 */
export async function sendMessage(
  ctx: Ctx,
  user: UserDTO,
  projectId: string,
  input: {
    body: string;
    replyToId: string | null;
    clientNonce: string;
    permission: PermissionProfile;
    confirmConcurrent: boolean;
  },
): Promise<SendMessageResult> {
  await requireMember(ctx.db, projectId, user.id);

  const existing = await ctx.db
    .select()
    .from(messages)
    .where(
      and(eq(messages.projectId, projectId), eq(messages.authorUserId, user.id), eq(messages.clientNonce, input.clientNonce)),
    );
  if (existing[0]) {
    const ds = await ctx.db.select().from(dispatches).where(eq(dispatches.messageId, existing[0].id));
    return {
      message: messageDTO(existing[0], { userName: user.displayName }),
      dispatches: ds.map(dispatchDTO),
      unavailable: [],
    };
  }

  if (input.replyToId) {
    const [r] = await ctx.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, input.replyToId), eq(messages.projectId, projectId)));
    if (!r) throw badRequest("replyToId does not refer to a message in this project");
  }

  // Resolve mentions against this project's agents and members only.
  const handles = extractMentions(input.body);
  const mentionedAgents = handles.length
    ? await ctx.db
        .select()
        .from(agents)
        .where(and(eq(agents.projectId, projectId), inArray(agents.handle, handles), isNull(agents.revokedAt)))
    : [];
  const userHandles = handles.filter((h) => !mentionedAgents.some((a) => a.handle === h));
  const mentionedUsers = userHandles.length
    ? await ctx.db
        .select({ id: users.id, username: users.username })
        .from(users)
        .innerJoin(projectMembers, and(eq(projectMembers.userId, users.id), eq(projectMembers.projectId, projectId)))
        .where(inArray(users.username, userHandles))
    : [];
  const mentions: MentionDTO[] = [
    ...mentionedAgents.map((a) => ({ type: "agent" as const, id: a.id, handle: a.handle })),
    ...mentionedUsers.map((u) => ({ type: "user" as const, id: u.id, handle: u.username })),
  ];

  const unavailable: SendMessageResult["unavailable"] = [];
  const targets: typeof mentionedAgents = [];
  for (const a of mentionedAgents) {
    const reason = await agentAvailability(ctx, a, user, input.permission);
    if (reason) unavailable.push({ handle: a.handle, reason });
    else targets.push(a);
  }

  const instruction = stripLeadingMentions(input.body);
  if (targets.length && !instruction) throw badRequest("Add an instruction after the @mention");

  if (targets.length && !input.confirmConcurrent) {
    const reasons: string[] = [];
    for (const a of targets) reasons.push(...(await concurrencyWarnings(ctx.db, projectId, a, input.permission, targets)));
    if (reasons.length) return { dispatches: [], unavailable, needsConfirmation: { reasons: [...new Set(reasons)] } };
  }

  const outbox = new Outbox();
  let result;
  try {
    result = await persist();
  } catch (err) {
    // A concurrent retry with the same nonce won the race: return its result.
    if (isUniqueViolation(err, "messages_nonce_uq")) return sendMessage(ctx, user, projectId, input);
    throw err;
  }
  await outbox.flush(ctx);
  for (const a of targets) await pumpAgent(ctx, a.id);
  return { ...result, unavailable };

  function persist() {
    return ctx.db.transaction(async (tx) => {
    const message = await insertMessage(tx, outbox, {
      projectId,
      kind: "human",
      authorType: "user",
      authorUserId: user.id,
      body: input.body,
      replyToId: input.replyToId,
      mentions,
      clientNonce: input.clientNonce,
      meta: targets.length ? { permission: input.permission } : {},
    });
    const created = [];
    for (const a of targets) {
      const d = await createDispatch(tx, outbox, {
        projectId,
        agent: a,
        requester: user,
        kind: "mention",
        instruction,
        taskId: null,
        messageId: message.id,
        permission: input.permission,
        idempotencyKey: `msg:${message.id}:${a.id}`,
      });
      created.push(dispatchDTO(d));
    }
    for (const u of unavailable) {
      await postSystemMessage(tx, outbox, projectId, `@${u.handle} did not receive this message: ${u.reason}`, {
        replyToId: message.id,
        meta: { notice: "agent_unavailable", handle: u.handle },
      });
    }
    return { message, dispatches: created };
    });
  }
}
