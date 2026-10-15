import { describe, expect, it } from "vitest";
import {
  TaskStatus,
  allowedTransitions,
  canTransition,
  extractMentions,
  parseReportedHandoff,
  stripLeadingMentions,
  SendMessageBody,
  RunComplete,
  ApprovalRequest,
  ApprovalDecision,
  APPROVAL_MAX_TIMEOUT_MS,
} from "../src/index.js";

describe("task state machine", () => {
  it("only humans complete tasks", () => {
    expect(canTransition("awaiting_review", "completed", "human")).toBe(true);
    expect(canTransition("awaiting_review", "completed", "agent")).toBe(false);
    expect(canTransition("running", "completed", "agent")).toBe(false);
    expect(canTransition("running", "completed", "human")).toBe(false);
  });

  it("agents report results only from running", () => {
    expect(allowedTransitions("running", "agent").sort()).toEqual(["awaiting_review", "blocked", "failed"]);
    for (const s of TaskStatus.options.filter((s) => s !== "running")) expect(allowedTransitions(s, "agent")).toEqual([]);
  });

  it("terminal states have no exits", () => {
    for (const actor of ["human", "agent", "system"] as const) {
      expect(allowedTransitions("completed", actor)).toEqual([]);
      expect(allowedTransitions("cancelled", actor)).toEqual([]);
    }
  });

  it("every rule targets a valid status", () => {
    for (const from of TaskStatus.options)
      for (const actor of ["human", "agent", "system"] as const)
        for (const to of allowedTransitions(from, actor)) expect(TaskStatus.options).toContain(to);
  });
});

describe("mentions", () => {
  it("extracts handles, ignores e-mail addresses, de-duplicates", () => {
    expect(extractMentions("@Claude implement auth, then @codex review. mail bob@example.com @claude")).toEqual(["claude", "codex"]);
    expect(extractMentions("(@codex) and @a")).toEqual(["codex"]);
    expect(extractMentions("no mentions")).toEqual([]);
  });
  it("strips leading mentions only", () => {
    expect(stripLeadingMentions("@claude, @codex: please fix @this")).toBe("please fix @this");
  });
});

describe("handoff parsing", () => {
  it("pulls the last fenced block and strips it from the reply", () => {
    const text = 'Done.\n\n```relayroom-handoff\n{"summary":"ok","testsRun":["npm test"]}\n```';
    const r = parseReportedHandoff(text);
    expect(r.cleanText).toBe("Done.");
    expect(r.reported).toMatchObject({ summary: "ok", testsRun: ["npm test"], workCompleted: [] });
  });
  it("returns null for invalid JSON or wrong shapes, keeping text clean", () => {
    expect(parseReportedHandoff("x\n```relayroom-handoff\n{nope}\n```").reported).toBeNull();
    expect(parseReportedHandoff('x\n```relayroom-handoff\n{"testsRun":"not-an-array"}\n```').reported).toBeNull();
    expect(parseReportedHandoff("plain reply").reported).toBeNull();
  });
});

describe("validation at trust boundaries", () => {
  it("rejects malformed messages", () => {
    expect(SendMessageBody.safeParse({ body: "", clientNonce: crypto.randomUUID() }).success).toBe(false);
    expect(SendMessageBody.safeParse({ body: "hi", clientNonce: "nope" }).success).toBe(false);
    expect(SendMessageBody.safeParse({ body: "x".repeat(8001), clientNonce: crypto.randomUUID() }).success).toBe(false);
    expect(SendMessageBody.safeParse({ body: "hi", clientNonce: crypto.randomUUID(), permission: "root" }).success).toBe(false);
  });
  it("rejects oversized or malformed run completions", () => {
    const base = {
      dispatchId: crypto.randomUUID(),
      outcome: "succeeded",
      exitCode: 0,
      executionId: null,
      finalText: "ok",
      errorMessage: null,
      durationMs: 1,
      observed: { commands: [], baseCommit: null, git: null, diff: null, diffTruncated: false, baseCheck: null },
      reported: null,
    };
    expect(RunComplete.safeParse(base).success).toBe(true);
    expect(RunComplete.safeParse({ ...base, outcome: "completed" }).success).toBe(false);
    expect(RunComplete.safeParse({ ...base, finalText: "x".repeat(60_001) }).success).toBe(false);
    expect(RunComplete.safeParse({ ...base, durationMs: -1 }).success).toBe(false);
  });
});

describe("approval wire schemas", () => {
  const base = {
    approvalId: "7a1c3c0e-2b8f-4d36-9a57-2f1f7d0e9b11",
    dispatchId: "0c6f4f43-5d3e-4a5b-9c43-1d7b5d1c2e33",
    toolName: "Bash",
    summary: "$ npm i",
    detail: "{}",
    timeoutMs: 60_000,
  };
  it("bounds the wait and the payload sizes", () => {
    expect(ApprovalRequest.safeParse(base).success).toBe(true);
    expect(ApprovalRequest.safeParse({ ...base, timeoutMs: APPROVAL_MAX_TIMEOUT_MS + 1 }).success).toBe(false);
    expect(ApprovalRequest.safeParse({ ...base, detail: "x".repeat(8001) }).success).toBe(false);
    expect(ApprovalRequest.safeParse({ ...base, toolName: "" }).success).toBe(false);
  });
  it("a decision is never pending", () => {
    const d = { approvalId: base.approvalId, dispatchId: base.dispatchId, reason: null, decidedBy: null };
    expect(ApprovalDecision.safeParse({ ...d, status: "approved" }).success).toBe(true);
    expect(ApprovalDecision.safeParse({ ...d, status: "pending" }).success).toBe(false);
  });
});
