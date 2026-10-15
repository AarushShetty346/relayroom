import { z } from "zod";

const Str = (max: number) => z.string().max(max);

export const ObservedCommand = z.object({
  command: Str(2000),
  /** Exact exit code when the provider reports one; otherwise null. */
  exitCode: z.number().int().nullable(),
  /** Whether the command succeeded, when known (some providers only report error/success). */
  ok: z.boolean().nullable(),
  /** Where the record came from, e.g. "claude-code:Bash" or "codex:command_execution". */
  source: Str(64),
});
export type ObservedCommand = z.infer<typeof ObservedCommand>;

/**
 * Facts the adapter observed itself (git, provider event stream, process exit code).
 * These are trustworthy to the extent the adapter is.
 */
export const HandoffObserved = z.object({
  filesChanged: z.array(z.object({ path: Str(1024), status: Str(4) })).max(500),
  commands: z.array(ObservedCommand).max(200),
  branch: Str(256).nullable(),
  baseCommit: Str(64).nullable(),
  headCommit: Str(64).nullable(),
  exitCode: z.number().int().nullable(),
  provider: Str(32),
  executionId: Str(128).nullable(),
});
export type HandoffObserved = z.infer<typeof HandoffObserved>;

/** What the agent says about its own work. Shown as a claim, not as verified fact. */
export const HandoffReported = z.object({
  summary: Str(8000).default(""),
  workCompleted: z.array(Str(2000)).max(50).default([]),
  testsRun: z.array(Str(2000)).max(50).default([]),
  testResults: Str(4000).default(""),
  unresolvedFailures: z.array(Str(2000)).max(50).default([]),
  limitations: z.array(Str(2000)).max(50).default([]),
  nextAction: Str(2000).default(""),
  decisions: z.array(Str(2000)).max(20).default([]),
  openQuestions: z.array(Str(2000)).max(20).default([]),
});
export type HandoffReported = z.infer<typeof HandoffReported>;

export const Handoff = z.object({
  objective: Str(8000),
  acceptanceCriteria: z.array(Str(2000)).max(50),
  observed: HandoffObserved,
  /** null when the agent did not produce a parseable structured handoff. */
  reported: HandoffReported.nullable(),
});
export type Handoff = z.infer<typeof Handoff>;

export const HANDOFF_FENCE = "relayroom-handoff";

/**
 * Instructions appended to task prompts. The agent is asked to end with a fenced JSON block.
 * Everything in it is treated as the agent's claim.
 */
export const HANDOFF_INSTRUCTIONS = `When you finish, end your reply with a fenced code block tagged \`${HANDOFF_FENCE}\` containing JSON with these keys:
{"summary": string, "workCompleted": string[], "testsRun": string[], "testResults": string, "unresolvedFailures": string[], "limitations": string[], "nextAction": string, "decisions": string[], "openQuestions": string[]}
Only list work, commands and tests you actually performed in this session. If you did not run tests, say so.`;

/**
 * Pulls the last relayroom-handoff block out of an agent reply. Returns the reply without the block
 * and the parsed report (or null if missing/invalid).
 */
export function parseReportedHandoff(text: string): { cleanText: string; reported: HandoffReported | null } {
  const re = new RegExp("```" + HANDOFF_FENCE + "\\s*\\n([\\s\\S]*?)```", "g");
  const matches = [...text.matchAll(re)];
  const last = matches.at(-1);
  if (!last) return { cleanText: text.trim(), reported: null };
  const cleanText = (text.slice(0, last.index) + text.slice(last.index! + last[0].length)).trim();
  try {
    const parsed = HandoffReported.safeParse(JSON.parse(last[1]!));
    return { cleanText, reported: parsed.success ? parsed.data : null };
  } catch {
    return { cleanText, reported: null };
  }
}
