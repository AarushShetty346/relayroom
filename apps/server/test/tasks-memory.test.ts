/**
 * Task state machine, handoffs/transfers, memory and context retrieval.
 * Agents are ADAPTER SIMULATIONS (SimulatedAdapter) — server behaviour only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DispatchPayload, TaskDetailDTO, TaskDTO } from "@relayroom/protocol";
import { Client, SimulatedAdapter, nonce, startTestServer, waitFor, type TestServer } from "./helpers.js";

let ts: TestServer;
beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.stop();
});

let n = 0;
async function project() {
  const owner = new Client(ts.baseUrl);
  const user = await owner.signup(`tm${++n}`, `TM ${n}`);
  const projectId = (await owner.post("/api/projects", { name: "T" })).body.project.id as string;
  const mk = async (handle: string) => {
    const r = await owner.post(`/api/projects/${projectId}/agents`, { handle, displayName: handle, provider: handle === "codex" ? "codex" : "claude-code" });
    const ad = new SimulatedAdapter(ts.baseUrl, r.body.token);
    await ad.connect();
    return { id: r.body.agent.id as string, ad };
  };
  return { owner, user, projectId, mk };
}

const newTask = async (c: Client, projectId: string, extra = {}) =>
  (await c.post(`/api/projects/${projectId}/tasks`, { title: "Implement auth", description: "JWT", acceptanceCriteria: ["tests pass"], ...extra })).body.task as TaskDTO;

describe("task state machine (server-enforced)", () => {
  it("numbers tasks per project and rejects invalid human transitions", async () => {
    const { owner, projectId } = await project();
    const t1 = await newTask(owner, projectId);
    const t2 = await newTask(owner, projectId);
    expect([t1.number, t2.number]).toEqual([1, 2]);
    expect(t1.status).toBe("queued");
    // queued → completed is not a valid transition
    expect((await owner.post(`/api/tasks/${t1.id}/transition`, { to: "completed" })).status).toBe(409);
    // assigned must go through the assign endpoint
    expect((await owner.post(`/api/tasks/${t1.id}/transition`, { to: "assigned" })).status).toBe(400);
    // unknown status
    expect((await owner.post(`/api/tasks/${t1.id}/transition`, { to: "done" })).status).toBe(400);
    // cancel is allowed and terminal
    expect((await owner.post(`/api/tasks/${t1.id}/transition`, { to: "cancelled" })).body.task.status).toBe("cancelled");
    expect((await owner.post(`/api/tasks/${t1.id}/transition`, { to: "queued" })).status).toBe(409);
    expect((await owner.patch(`/api/tasks/${t1.id}`, { title: "x" })).status).toBe(409);
  });

  it("a human-owned task can be started, reviewed and completed by humans", async () => {
    const { owner, user, projectId } = await project();
    const t = await newTask(owner, projectId);
    await owner.post(`/api/tasks/${t.id}/assign`, { assignee: { type: "user", id: user.id } });
    for (const to of ["running", "awaiting_review", "completed"]) {
      const r = await owner.post(`/api/tasks/${t.id}/transition`, { to });
      expect(r.status, to).toBe(200);
    }
  });

  it("agent tasks cannot be marked running by hand, and agents cannot complete them", async () => {
    const { owner, projectId, mk } = await project();
    const claude = await mk("claude");
    const t = await newTask(owner, projectId);
    await owner.post(`/api/tasks/${t.id}/assign`, { assignee: { type: "agent", id: claude.id } });
    const d = await waitFor(() => claude.ad.received[0]);
    expect(d.kind).toBe("task");
    expect(d.permission).toBe("edit");
    expect((await owner.post(`/api/tasks/${t.id}/transition`, { to: "running" })).status).toBe(409);
    await claude.ad.accept(d.dispatchId);
    // Reassigning while running is refused.
    expect((await owner.post(`/api/tasks/${t.id}/assign`, { assignee: null })).status).toBe(409);
    // A completion with no text and no report does not reach review.
    await claude.ad.complete(d.dispatchId, { finalText: "" });
    const detail = (await owner.get(`/api/tasks/${t.id}`)).body as TaskDetailDTO;
    expect(detail.task.status).toBe("blocked");
    expect(detail.history.at(-1)!.note).toMatch(/no result/);
  });

  it("failed runs fail the task; a retry by reassignment works", async () => {
    const { owner, projectId, mk } = await project();
    const claude = await mk("claude");
    const t = await newTask(owner, projectId);
    await owner.post(`/api/tasks/${t.id}/assign`, { assignee: { type: "agent", id: claude.id } });
    const d1 = await waitFor(() => claude.ad.received[0]);
    await claude.ad.accept(d1.dispatchId);
    await claude.ad.complete(d1.dispatchId, { outcome: "failed", exitCode: 2, finalText: "", errorMessage: "tests failed" });
    expect(((await owner.get(`/api/tasks/${t.id}`)).body as TaskDetailDTO).task.status).toBe("failed");
    await owner.post(`/api/tasks/${t.id}/assign`, { assignee: { type: "agent", id: claude.id } });
    const d2 = await waitFor(() => claude.ad.received[1]);
    expect(d2.dispatchId).not.toBe(d1.dispatchId);
  });

  it("refuses to assign agents from another project or non-members", async () => {
    const a = await project();
    const b = await project();
    const other = await b.mk("claude");
    const t = await newTask(a.owner, a.projectId);
    expect((await a.owner.post(`/api/tasks/${t.id}/assign`, { assignee: { type: "agent", id: other.id } })).status).toBe(400);
    expect((await a.owner.post(`/api/tasks/${t.id}/assign`, { assignee: { type: "user", id: b.user.id } })).status).toBe(400);
    // Non-members cannot read or change the task at all.
    expect((await b.owner.get(`/api/tasks/${t.id}`)).status).toBe(404);
    expect((await b.owner.post(`/api/tasks/${t.id}/transition`, { to: "cancelled" })).status).toBe(404);
  });
});

describe("concurrency", () => {
  it("parallel assignments of one task start exactly one run", async () => {
    const { owner, projectId, mk } = await project();
    const claude = await mk("claude");
    const t = await newTask(owner, projectId);
    const body = { assignee: { type: "agent", id: claude.id }, confirmConcurrent: true };
    const rs = await Promise.all([1, 2, 3, 4].map(() => owner.post(`/api/tasks/${t.id}/assign`, body)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
    const detail = (await owner.get(`/api/tasks/${t.id}`)).body as TaskDetailDTO;
    expect(detail.dispatches).toHaveLength(1);
  });

  it("a single-use invite admits exactly one of several racing users", async () => {
    const { owner, projectId } = await project();
    const code = (await owner.post(`/api/projects/${projectId}/invites`, { maxUses: 1 })).body.invite.code;
    const users = await Promise.all(
      [1, 2, 3, 4].map(async (i) => {
        const c = new Client(ts.baseUrl);
        await c.signup(`racer${n}x${i}`);
        return c;
      }),
    );
    const rs = await Promise.all(users.map((c) => c.post("/api/invites/accept", { code })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    const members = (await owner.get(`/api/projects/${projectId}`)).body.members;
    expect(members).toHaveLength(2);
  });

  it("parallel completions of one run produce one reply", async () => {
    const { owner, projectId, mk } = await project();
    const claude = await mk("claude");
    await owner.post(`/api/projects/${projectId}/messages`, { body: "@claude go", clientNonce: nonce() });
    const d = await waitFor(() => claude.ad.received[0]);
    await claude.ad.accept(d.dispatchId);
    const rs = await Promise.all([1, 2, 3].map(() => claude.ad.complete(d.dispatchId)));
    expect(rs.every((r) => r.ok)).toBe(true);
    const msgs = (await owner.get(`/api/projects/${projectId}/messages?limit=200`)).body.messages;
    expect(msgs.filter((m: { kind: string }) => m.kind === "agent")).toHaveLength(1);
  });
});

describe("structured handoffs and transfers", () => {
  it("persists the handoff and gives it, with decisions, to the next agent", async () => {
    const { owner, projectId, mk } = await project();
    const claude = await mk("claude");
    const codex = await mk("codex");
    await owner.post(`/api/projects/${projectId}/memory`, { kind: "constraint", title: "Do not change the public auth interface" });
    const t = await newTask(owner, projectId);
    await owner.post(`/api/tasks/${t.id}/assign`, { assignee: { type: "agent", id: claude.id } });
    const d1 = await waitFor(() => claude.ad.received[0]);
    expect(d1.context.some((c) => c.title === "Do not change the public auth interface" && c.status === "verified")).toBe(true);
    await claude.ad.accept(d1.dispatchId);
    await claude.ad.complete(d1.dispatchId, {
      finalText: "Implemented on feature/auth.",
      observed: {
        commands: [{ command: "npm test", exitCode: 0, ok: true, source: "sim" }],
        baseCommit: "a".repeat(40),
        git: { isRepo: true, branch: "feature/auth", head: "b".repeat(40), upstream: null, ahead: null, behind: null, dirty: true, changedFiles: [{ path: "src/auth.ts", status: "M" }], collectedAt: new Date().toISOString() },
        diff: "diff --git a/src/auth.ts b/src/auth.ts\n+validate()",
        diffTruncated: false,
        baseCheck: null,
      },
      reported: {
        summary: "JWT auth added",
        workCompleted: ["auth flow"],
        testsRun: ["npm test"],
        testResults: "unit tests pass; integration not run",
        unresolvedFailures: [],
        limitations: ["integration test unverified"],
        nextAction: "security review",
        decisions: [],
        openQuestions: [],
      },
    });
    let detail = (await owner.get(`/api/tasks/${t.id}`)).body as TaskDetailDTO;
    expect(detail.task).toMatchObject({ status: "awaiting_review", branch: "feature/auth", commit: "b".repeat(40) });
    expect(detail.handoffs[0]!.handoff.observed.commands[0]!.command).toBe("npm test");

    // Human transfers the task to Codex with a note.
    const tr = await owner.post(`/api/tasks/${t.id}/assign`, { assignee: { type: "agent", id: codex.id }, note: "review for token validation issues" });
    expect(tr.status).toBe(200);
    const d2: DispatchPayload = await waitFor(() => codex.ad.received[0]);
    expect(d2.instruction).toContain("review for token validation issues");
    expect(d2.expectedCommit).toBe("b".repeat(40));
    const handoffCtx = d2.context.find((c) => c.kind === "handoff");
    expect(handoffCtx?.body).toContain("src/auth.ts");
    expect(handoffCtx?.body).toContain("unverified claim");
    expect(handoffCtx?.body).toContain("integration not run");
    detail = (await owner.get(`/api/tasks/${t.id}`)).body as TaskDetailDTO;
    const transfer = detail.handoffs.at(-1)!;
    expect(transfer.from.type).toBe("user");
    expect(transfer.to?.name).toBe("@codex");
    expect(transfer.diff).toContain("validate()");

    // Codex works from a stale base: the server warns the room.
    await codex.ad.accept(d2.dispatchId);
    await codex.ad.complete(d2.dispatchId, {
      finalText: "Found an issue.",
      observed: { commands: [], baseCommit: null, git: null, diff: null, diffTruncated: false, baseCheck: { expectedCommit: "b".repeat(40), present: false, isAncestorOfHead: false } },
    });
    const msgs = (await owner.get(`/api/projects/${projectId}/messages?limit=200`)).body.messages;
    expect(msgs.some((m: { meta: { notice?: string } }) => m.meta.notice === "stale_base")).toBe(true);
  });

  it("warns about overlapping uncommitted changes between agents", async () => {
    const { owner, projectId, mk } = await project();
    const a = await mk("claude");
    const b = await mk("codex");
    const git = (files: string[]) => ({ isRepo: true, branch: "main", head: "c".repeat(40), upstream: null, ahead: null, behind: null, dirty: true, changedFiles: files.map((path) => ({ path, status: "M" })), collectedAt: new Date().toISOString() });
    b.ad.socket.emit("heartbeat", { state: "idle", activeDispatchIds: [], repo: git(["src/auth.ts", "README.md"]) });
    await owner.post(`/api/projects/${projectId}/messages`, { body: "@claude tweak auth", clientNonce: nonce(), permission: "edit" });
    const d = await waitFor(() => a.ad.received[0]);
    await a.ad.accept(d.dispatchId);
    await a.ad.complete(d.dispatchId, { observed: { commands: [], baseCommit: null, git: git(["src/auth.ts"]), diff: null, diffTruncated: false, baseCheck: null } });
    const msgs = (await owner.get(`/api/projects/${projectId}/messages?limit=200`)).body.messages;
    const warn = msgs.find((m: { meta: { notice?: string } }) => m.meta.notice === "conflict_risk");
    expect(warn.body).toContain("@codex");
    expect(warn.body).toContain("src/auth.ts");
  });
});

describe("project memory", () => {
  it("humans create, correct, verify and remove entries; agents only suggest", async () => {
    const { owner, projectId, mk } = await project();
    const claude = await mk("claude");
    const created = (await owner.post(`/api/projects/${projectId}/memory`, { kind: "decision", title: "Use JWT", status: "verified" })).body.entry;
    expect(created.source).toMatchObject({ type: "user" });
    expect(created.verifiedBy).not.toBeNull();

    await owner.post(`/api/projects/${projectId}/messages`, { body: "@claude decide something", clientNonce: nonce() });
    const d = await waitFor(() => claude.ad.received[0]);
    await claude.ad.accept(d.dispatchId);
    await claude.ad.complete(d.dispatchId, {
      reported: { summary: "", workCompleted: [], testsRun: [], testResults: "", unresolvedFailures: [], limitations: [], nextAction: "", decisions: ["Switch to sessions"], openQuestions: [] },
    });
    let entries = (await owner.get(`/api/projects/${projectId}/memory`)).body.entries;
    const sug = entries.find((e: { title: string }) => e.title === "Switch to sessions");
    expect(sug).toMatchObject({ status: "suggested", source: { type: "agent" } });

    // Unverified suggestions are labelled as such in later agent context.
    await owner.post(`/api/projects/${projectId}/messages`, { body: "@claude should we switch to sessions?", clientNonce: nonce() });
    const d2 = await waitFor(() => claude.ad.received[1]);
    expect(d2.context.find((c) => c.title === "Switch to sessions")?.status).toMatch(/^UNVERIFIED/);

    // Human corrects and verifies it, then deletes the old decision.
    const ver = (await owner.patch(`/api/memory/${sug.id}`, { title: "Keep JWT, add rotation", status: "verified" })).body.entry;
    expect(ver).toMatchObject({ status: "verified", title: "Keep JWT, add rotation" });
    expect((await owner.del(`/api/memory/${created.id}`)).status).toBe(200);
    entries = (await owner.get(`/api/projects/${projectId}/memory`)).body.entries;
    expect(entries.map((e: { title: string }) => e.title)).toEqual(["Keep JWT, add rotation"]);
  });

  it("rejects cross-project references and non-member access", async () => {
    const a = await project();
    const b = await project();
    const tb = await newTask(b.owner, b.projectId);
    expect((await a.owner.post(`/api/projects/${a.projectId}/memory`, { kind: "fact", title: "x", taskId: tb.id })).status).toBe(400);
    const m = (await b.owner.post(`/api/projects/${b.projectId}/memory`, { kind: "fact", title: "secret" })).body.entry;
    expect((await a.owner.patch(`/api/memory/${m.id}`, { title: "pwned" })).status).toBe(404);
    expect((await a.owner.del(`/api/memory/${m.id}`)).status).toBe(404);
  });

  it("search finds messages, tasks and memory within the project only", async () => {
    const a = await project();
    const b = await project();
    await a.owner.post(`/api/projects/${a.projectId}/messages`, { body: "the zebra migration", clientNonce: nonce() });
    await newTask(a.owner, a.projectId, { title: "Zebra cleanup" });
    await b.owner.post(`/api/projects/${b.projectId}/messages`, { body: "zebra elsewhere", clientNonce: nonce() });
    const r = (await a.owner.get(`/api/projects/${a.projectId}/search?q=zebra`)).body;
    expect(r.messages.map((m: { body: string }) => m.body)).toContain("the zebra migration");
    expect(r.messages.map((m: { body: string }) => m.body)).not.toContain("zebra elsewhere");
    expect(r.tasks[0].title).toBe("Zebra cleanup");
    // LIKE wildcards are escaped
    expect((await a.owner.get(`/api/projects/${a.projectId}/search?q=%25%25`)).body.messages).toEqual([]);
  });
});
