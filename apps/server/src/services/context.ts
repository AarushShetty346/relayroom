import { and, desc, eq, inArray, lt, ne } from "drizzle-orm";
import type { ContextItem, Handoff } from "@relayroom/protocol";
import type { DbOrTx } from "../db/client.js";
import { agents, handoffs, memoryEntries, messages, users } from "../db/schema.js";

const MAX_ITEMS = 30;
const MAX_TOTAL_CHARS = 24_000;
const STOP = new Set(
  "the a an and or to of in on for with is are be it this that from by as at we you i our your can should not do does please".split(" "),
);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

function overlap(a: Set<string>, text: string): number {
  let n = 0;
  for (const w of keywords(text)) if (a.has(w)) n++;
  return n;
}

export function summarizeHandoff(h: Handoff, fromName: string, note: string): string {
  const lines: string[] = [];
  if (note) lines.push(`Transfer note: ${note}`);
  const o = h.observed;
  lines.push(
    `Observed by adapter (${o.provider}): exit code ${o.exitCode ?? "unknown"}, branch ${o.branch ?? "unknown"}, head ${o.headCommit?.slice(0, 12) ?? "unknown"}.`,
  );
  if (o.filesChanged.length) lines.push(`Files changed (git): ${o.filesChanged.slice(0, 40).map((f) => f.path).join(", ")}`);
  if (o.commands.length)
    lines.push(`Commands run: ${o.commands.slice(0, 15).map((c) => `${c.command} (${c.exitCode !== null ? `exit ${c.exitCode}` : c.ok === null ? "result unknown" : c.ok ? "ok" : "error"})`).join("; ")}`);
  const r = h.reported;
  if (r) {
    lines.push(`${fromName} reported (unverified claim):`);
    if (r.summary) lines.push(`  Summary: ${r.summary}`);
    if (r.workCompleted.length) lines.push(`  Work completed: ${r.workCompleted.join("; ")}`);
    if (r.testsRun.length) lines.push(`  Tests run: ${r.testsRun.join("; ")}`);
    if (r.testResults) lines.push(`  Test results: ${r.testResults}`);
    if (r.unresolvedFailures.length) lines.push(`  Unresolved failures: ${r.unresolvedFailures.join("; ")}`);
    if (r.limitations.length) lines.push(`  Known limitations: ${r.limitations.join("; ")}`);
    if (r.nextAction) lines.push(`  Recommended next action: ${r.nextAction}`);
  } else {
    lines.push(`${fromName} did not provide a structured report.`);
  }
  return lines.join("\n");
}

/**
 * Retrieves a bounded slice of project context for a dispatch, instead of the whole chat history:
 * the task's latest handoffs, verified decisions/constraints, relevant agent suggestions (labelled as
 * unverified), and a few recent related messages.
 */
export async function buildContext(
  db: DbOrTx,
  input: { projectId: string; taskId: string | null; messageId: string | null; instruction: string },
): Promise<{ items: ContextItem[]; expectedCommit: string | null }> {
  const items: ContextItem[] = [];
  let expectedCommit: string | null = null;
  const kw = keywords(input.instruction);

  if (input.taskId) {
    const hs = await db
      .select()
      .from(handoffs)
      .where(eq(handoffs.taskId, input.taskId))
      .orderBy(desc(handoffs.createdAt))
      .limit(3);
    for (const h of hs.reverse()) {
      const data = h.data as Handoff;
      expectedCommit = data.observed.headCommit ?? expectedCommit;
      items.push({
        kind: "handoff",
        title: `Handoff from ${h.fromName} (${h.createdAt.toISOString()})`,
        body: summarizeHandoff(data, h.fromName, h.note),
        status: data.reported ? "reported" : "observed-only",
      });
    }
  }

  const mem = await db
    .select()
    .from(memoryEntries)
    .where(eq(memoryEntries.projectId, input.projectId))
    .orderBy(desc(memoryEntries.updatedAt))
    .limit(300);
  const always = new Set(["constraint", "convention", "decision"]);
  const scored = mem
    .map((m) => ({
      m,
      score:
        (m.taskId && m.taskId === input.taskId ? 5 : 0) +
        overlap(kw, `${m.title} ${m.body}`) * 2 +
        (m.status === "verified" && always.has(m.kind) ? 3 : 0) -
        (m.status === "verified" ? 0 : 1),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
  for (const { m } of scored) {
    items.push({
      kind: m.kind,
      title: m.title,
      body: m.body,
      status: m.status === "verified" ? "verified" : `UNVERIFIED (${m.status}, from ${m.sourceName})`,
    });
  }

  // Recent conversation around the trigger: task-linked messages, or the last few room messages.
  let anchorSeq: bigint | null = null;
  let replyToId: string | null = null;
  if (input.messageId) {
    const [anchor] = await db.select().from(messages).where(eq(messages.id, input.messageId));
    anchorSeq = anchor?.seq ?? null;
    replyToId = anchor?.replyToId ?? null;
  }
  const conds = [eq(messages.projectId, input.projectId), inArray(messages.kind, ["human", "agent"] as const)];
  if (input.taskId) conds.push(eq(messages.taskId, input.taskId));
  if (anchorSeq !== null) conds.push(lt(messages.seq, anchorSeq));
  if (input.messageId) conds.push(ne(messages.id, input.messageId));
  const recent = await db
    .select({ m: messages, userName: users.displayName, agentName: agents.displayName })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(and(...conds))
    .orderBy(desc(messages.seq))
    .limit(8);
  if (replyToId && !recent.some((r) => r.m.id === replyToId)) {
    const [r] = await db
      .select({ m: messages, userName: users.displayName, agentName: agents.displayName })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorUserId))
      .leftJoin(agents, eq(agents.id, messages.authorAgentId))
      .where(and(eq(messages.id, replyToId), eq(messages.projectId, input.projectId)));
    if (r) recent.push(r);
  }
  for (const r of recent.reverse()) {
    const who = r.m.authorType === "agent" ? `${r.agentName ?? "agent"} (agent)` : (r.userName ?? "user");
    items.push({
      kind: r.m.id === replyToId ? "replied_message" : "message",
      title: `${who} at ${r.m.createdAt.toISOString()}`,
      body: r.m.body.slice(0, 2000),
      status: null,
    });
  }

  // Enforce the overall budget, dropping the oldest conversation first.
  let total = items.reduce((n, i) => n + i.body.length + i.title.length, 0);
  while ((total > MAX_TOTAL_CHARS || items.length > MAX_ITEMS) && items.length) {
    const idx = items.findIndex((i) => i.kind === "message");
    const [removed] = items.splice(idx >= 0 ? idx : items.length - 1, 1);
    total -= removed!.body.length + removed!.title.length;
  }
  return { items, expectedCommit };
}
