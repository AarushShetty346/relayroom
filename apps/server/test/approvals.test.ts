/**
 * Human-in-the-loop approvals.
 *
 * SIMULATIONS: the first block drives the server with SimulatedAdapter (a scripted stand-in speaking
 * the real wire protocol); the second runs the real Adapter runtime with a SCRIPTED DRIVER that calls
 * the approvals hook the way the Claude Code driver does when Claude Code invokes its permission
 * prompt tool. Neither involves a real Claude Code process: that a real permission prompt reaches the
 * hook was not observed (the CLI on this machine is not logged in). See PROGRESS.md.
 */
import { removeTemp } from "./tmp.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Adapter,
  validateProjectDir,
  type AdapterConfig,
  type ProviderDriver,
  type RunOptions,
  type RunResult,
  type ToolPermissionDecision,
} from "@relayroom/adapter";
import type { ApprovalDTO, MessageDTO } from "@relayroom/protocol";
import { Client, SimulatedAdapter, delay, nonce, startTestServer, waitFor, type TestServer } from "./helpers.js";

let ts: TestServer;
const dirs: string[] = [];
beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.stop();
  for (const d of dirs) removeTemp(d);
});

let n = 0;
/** Project owner, a member who asks for the run, an outsider member, and an agent owned by the owner. */
async function team() {
  const owner = new Client(ts.baseUrl);
  const ownerUser = await owner.signup(`apown${++n}`, `Owner ${n}`);
  const projectId = (await owner.post("/api/projects", { name: "Approvals" })).body.project.id as string;
  const join = async (name: string) => {
    const c = new Client(ts.baseUrl);
    const u = await c.signup(`${name}${n}`, `${name} ${n}`);
    const code = (await owner.post(`/api/projects/${projectId}/invites`, { maxUses: 1 })).body.invite.code;
    expect((await c.post("/api/invites/accept", { code })).status).toBe(200);
    return { c, u };
  };
  const requester = await join("req");
  const bystander = await join("bys");
  const reg = await owner.post(`/api/projects/${projectId}/agents`, { handle: "claude", displayName: "Claude", provider: "claude-code" });
  return { owner, ownerUser, projectId, requester, bystander, agentId: reg.body.agent.id as string, token: reg.body.token as string };
}

/** The requester mentions the agent with edit permission; the simulated adapter accepts the dispatch. */
async function runningDispatch(t: Awaited<ReturnType<typeof team>>, sim: SimulatedAdapter) {
  const sent = await t.requester.c.post(`/api/projects/${t.projectId}/messages`, { body: "@claude add left-pad", clientNonce: nonce(), permission: "edit" });
  expect(sent.status).toBe(201);
  const d = await waitFor(() => sim.received.at(-1));
  expect((await sim.accept(d.dispatchId)).ok).toBe(true);
  return d.dispatchId;
}

describe("approvals on the server (SimulatedAdapter — simulation)", () => {
  it("persists and broadcasts a request; only requester / agent owner / project owner may decide; decision reaches the adapter", async () => {
    const t = await team();
    const sim = new SimulatedAdapter(ts.baseUrl, t.token);
    expect((await sim.connect()).ok).toBe(true);
    const dispatchId = await runningDispatch(t, sim);
    const room = await t.bystander.c.socket(t.projectId);
    const updates: ApprovalDTO[] = [];
    const msgs: MessageDTO[] = [];
    room.on("approval:updated", (a: ApprovalDTO) => updates.push(a));
    room.on("message:new", (m: MessageDTO) => msgs.push(m));

    const { ack, req } = await sim.requestApproval(dispatchId);
    expect(ack).toEqual({ ok: true });
    const pending = await waitFor(() => updates.find((a) => a.id === req.approvalId));
    expect(pending).toMatchObject({ status: "pending", toolName: "Bash", summary: "$ npm install left-pad", requestedBy: t.requester.u.id, agentOwnerId: t.ownerUser.id });
    await waitFor(() => msgs.find((m) => m.meta.notice === "approval_requested"));
    const listed = (await t.bystander.c.get(`/api/projects/${t.projectId}/approvals`)).body.approvals as ApprovalDTO[];
    expect(listed.map((a) => a.id)).toContain(req.approvalId);

    // A member who neither asked for the run nor owns the agent/project cannot decide.
    const denied = await t.bystander.c.post(`/api/approvals/${req.approvalId}/decide`, { decision: "approve" });
    expect(denied.status).toBe(403);
    // Non-members cannot even see it.
    const stranger = new Client(ts.baseUrl);
    await stranger.signup(`stranger${n}`);
    expect((await stranger.post(`/api/approvals/${req.approvalId}/decide`, { decision: "approve" })).status).toBe(404);
    expect(sim.decisions).toHaveLength(0);

    const ok = await t.requester.c.post(`/api/approvals/${req.approvalId}/decide`, { decision: "approve", reason: "fine" });
    expect(ok.status).toBe(200);
    expect(ok.body.approval).toMatchObject({ status: "approved", decidedBy: { id: t.requester.u.id }, reason: "fine" });
    const d = await waitFor(() => sim.decisions.find((x) => x.approvalId === req.approvalId));
    expect(d).toMatchObject({ status: "approved", dispatchId, decidedBy: { id: t.requester.u.id } });
    await waitFor(() => updates.find((a) => a.id === req.approvalId && a.status === "approved"));
    await waitFor(() => msgs.find((m) => m.meta.notice === "approval_decided"));

    // Decided once: a second decision conflicts, and a re-sent request (after a reconnect) gets the decision.
    expect((await t.owner.post(`/api/approvals/${req.approvalId}/decide`, { decision: "deny" })).status).toBe(409);
    const again = await sim.requestApproval(dispatchId, { approvalId: req.approvalId });
    expect(again.ack).toMatchObject({ ok: true, decision: { status: "approved", approvalId: req.approvalId } });

    // The agent owner (= project owner here) may decide too.
    const second = await sim.requestApproval(dispatchId, { summary: "$ curl https://example.invalid" });
    const byOwner = await t.owner.post(`/api/approvals/${second.req.approvalId}/decide`, { decision: "deny", reason: "no network" });
    expect(byOwner.body.approval).toMatchObject({ status: "denied", reason: "no network" });
    await waitFor(() => sim.decisions.find((x) => x.approvalId === second.req.approvalId && x.status === "denied" && x.reason === "no network"));
    room.disconnect();
    sim.disconnect();
  });

  it("expires to a denial when nobody decides in time", async () => {
    const t = await team();
    const sim = new SimulatedAdapter(ts.baseUrl, t.token);
    await sim.connect();
    const dispatchId = await runningDispatch(t, sim);
    const { req } = await sim.requestApproval(dispatchId, { timeoutMs: 1_000 });
    const d = await waitFor(() => sim.decisions.find((x) => x.approvalId === req.approvalId), 5000);
    expect(d.status).toBe("expired");
    const late = await t.requester.c.post(`/api/approvals/${req.approvalId}/decide`, { decision: "approve" });
    expect(late.status).toBe(409);
    sim.disconnect();
  });

  it("closes open requests when the run ends or is cancelled, and refuses requests for runs that are not running", async () => {
    const t = await team();
    const sim = new SimulatedAdapter(ts.baseUrl, t.token);
    await sim.connect();
    const dispatchId = await runningDispatch(t, sim);
    const a = await sim.requestApproval(dispatchId);
    // Cancelling the run cancels its open request and tells the adapter.
    expect((await t.requester.c.post(`/api/dispatches/${dispatchId}/cancel`)).body.status).toBe("cancel_requested");
    await waitFor(() => sim.decisions.find((x) => x.approvalId === a.req.approvalId && x.status === "cancelled"));
    // New requests during cancellation are answered with a cancellation at once.
    const b = await sim.requestApproval(dispatchId);
    expect(b.ack).toMatchObject({ ok: true, decision: { status: "cancelled" } });
    expect((await sim.complete(dispatchId, { outcome: "cancelled" })).ok).toBe(true);
    const c = await sim.requestApproval(dispatchId);
    expect(c.ack).toMatchObject({ ok: false, error: "Dispatch is not running" });

    // A finished run leaves no pending request behind.
    const d2 = await runningDispatch(t, sim);
    const p = await sim.requestApproval(d2);
    expect((await sim.complete(d2)).ok).toBe(true);
    const list = (await t.owner.get(`/api/projects/${t.projectId}/approvals`)).body.approvals as ApprovalDTO[];
    expect(list.find((x) => x.id === p.req.approvalId)?.status).toBe("cancelled");
    // Another agent cannot attach requests to this agent's dispatch.
    const otherReg = await t.owner.post(`/api/projects/${t.projectId}/agents`, { handle: "codex", displayName: "Codex", provider: "codex" });
    const other = new SimulatedAdapter(ts.baseUrl, otherReg.body.token);
    await other.connect();
    expect((await other.requestApproval(d2)).ack).toMatchObject({ ok: false, error: "Unknown dispatch" });
    other.disconnect();
    sim.disconnect();
  });
});

// ---------- Real adapter runtime + scripted driver ----------

const quietLog = { info() {}, warn() {}, error() {} };

function repo(): string {
  const d = validateProjectDir(mkdtempSync(path.join(tmpdir(), "rr-appr-")));
  dirs.push(d);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: d });
  g("init", "-q", "-b", "main");
  writeFileSync(path.join(d, "a.txt"), "a\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  return d;
}

const ok = (finalText: string): RunResult => ({
  outcome: "succeeded",
  exitCode: 0,
  executionId: "exec-1",
  finalText,
  errorMessage: null,
  commands: [],
  permissionDenials: [],
});

/** Scripted provider that raises permission prompts through the approvals hook, like the Claude driver's bridge. */
function promptingDriver(script: (o: RunOptions) => Promise<RunResult>): ProviderDriver & { offered: boolean[] } {
  const offered: boolean[] = [];
  return {
    id: "claude-code",
    label: "Scripted",
    capabilities: { progressEvents: true, cancel: true, edit: true, approvals: true },
    offered,
    async detect() {
      return { bin: "scripted", version: "scripted-1" };
    },
    run(o) {
      offered.push(!!o.approvals);
      return script(o);
    },
  };
}

async function adapterRoom(t: Awaited<ReturnType<typeof team>>, driver: ProviderDriver, extra: Partial<AdapterConfig> = {}) {
  const projectDir = repo();
  const cfg: AdapterConfig = {
    serverUrl: ts.baseUrl,
    projectDir,
    provider: "claude-code",
    maxPermission: "edit",
    timeoutMs: 60_000,
    worktrees: false,
    token: t.token,
    journalPath: path.join(projectDir, "..", `${path.basename(projectDir)}-journal.json`),
    approvals: true,
    approvalTimeoutMs: 60_000,
    ...extra,
  };
  dirs.push(cfg.journalPath);
  const adapter = new Adapter(cfg, driver, quietLog);
  await adapter.start();
  for (let i = 0; i < 100; i++) {
    const a = (await t.owner.get(`/api/projects/${t.projectId}/agents`)).body.agents[0];
    if (a.status === "online") return { adapter, cfg, agent: a };
    await delay(50);
  }
  throw new Error("agent never came online");
}

async function pendingApprovals(t: Awaited<ReturnType<typeof team>>): Promise<ApprovalDTO[]> {
  for (let i = 0; i < 200; i++) {
    const list = (await t.owner.get(`/api/projects/${t.projectId}/approvals`)).body.approvals as ApprovalDTO[];
    const p = list.filter((a) => a.status === "pending");
    if (p.length) return p;
    await delay(25);
  }
  throw new Error("no pending approval appeared");
}

describe("approvals through the real adapter runtime (scripted driver — simulation)", () => {
  it("pauses the run on a prompt, resumes with allow after a human approves, and reports it", async () => {
    const t = await team();
    const decisions: ToolPermissionDecision[] = [];
    const driver = promptingDriver(async (o) => {
      decisions.push(await o.approvals!.request({ toolName: "Bash", input: { command: "npm install left-pad" }, toolUseId: "tu_1" }));
      return ok("Installed left-pad.");
    });
    const { adapter, agent } = await adapterRoom(t, driver);
    expect(agent.capabilities.approvals).toBe(true);
    const room = await t.owner.socket(t.projectId);
    const events: { text: string }[] = [];
    room.on("run:event", (e: { text: string }) => events.push(e));
    const seen: MessageDTO[] = [];
    room.on("message:new", (m: MessageDTO) => seen.push(m));

    await t.requester.c.post(`/api/projects/${t.projectId}/messages`, { body: "@claude add left-pad", clientNonce: nonce(), permission: "edit" });
    const [p] = await pendingApprovals(t);
    expect(p).toMatchObject({ toolName: "Bash", summary: "$ npm install left-pad" });
    expect(JSON.parse(p!.detail)).toEqual({ command: "npm install left-pad" });
    await waitFor(() => events.find((e) => e.text.startsWith("Waiting for approval: $ npm install left-pad")));
    await delay(100);
    expect(decisions).toHaveLength(0); // the run is paused on the decision

    expect((await t.requester.c.post(`/api/approvals/${p!.id}/decide`, { decision: "approve" })).status).toBe(200);
    const reply = await waitFor(() => seen.find((m) => m.kind === "agent"));
    expect(reply.body).toBe("Installed left-pad.");
    expect(decisions).toEqual([{ allow: true }]);
    expect(driver.offered).toEqual([true]);
    await waitFor(() => events.find((e) => e.text.startsWith("Approved by req")));
    await adapter.stop();
    room.disconnect();
  });

  it("passes a human denial and its note to the agent", async () => {
    const t = await team();
    const decisions: ToolPermissionDecision[] = [];
    const driver = promptingDriver(async (o) => {
      decisions.push(await o.approvals!.request({ toolName: "WebFetch", input: { url: "https://example.invalid/x" }, toolUseId: null }));
      return ok("Skipped the fetch.");
    });
    const { adapter } = await adapterRoom(t, driver);
    await t.requester.c.post(`/api/projects/${t.projectId}/messages`, { body: "@claude fetch it", clientNonce: nonce(), permission: "edit" });
    const [p] = await pendingApprovals(t);
    expect(p!.summary).toBe("WebFetch https://example.invalid/x");
    await t.owner.post(`/api/approvals/${p!.id}/decide`, { decision: "deny", reason: "use the vendored copy" });
    await waitFor(() => decisions.length === 1);
    expect(decisions[0]).toMatchObject({ allow: false });
    expect((decisions[0] as { message: string }).message).toContain("use the vendored copy");
    await adapter.idle;
    await adapter.stop();
  });

  it("the local cap wins: hard-denied commands and paths outside the directory are denied without asking", async () => {
    const t = await team();
    const decisions: ToolPermissionDecision[] = [];
    const driver = promptingDriver(async (o) => {
      decisions.push(await o.approvals!.request({ toolName: "Bash", input: { command: "git add . && git push origin main" }, toolUseId: null }));
      decisions.push(await o.approvals!.request({ toolName: "Write", input: { file_path: path.join(o.cwd, "..", "outside.txt"), content: "x" }, toolUseId: null }));
      return ok("done");
    });
    const { adapter } = await adapterRoom(t, driver);
    const room = await t.owner.socket(t.projectId);
    const seen: MessageDTO[] = [];
    room.on("message:new", (m: MessageDTO) => seen.push(m));
    await t.requester.c.post(`/api/projects/${t.projectId}/messages`, { body: "@claude ship it", clientNonce: nonce(), permission: "edit" });
    await waitFor(() => seen.find((m) => m.kind === "agent"));
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => !d.allow)).toBe(true);
    expect((decisions[0] as { message: string }).message).toContain("git push");
    expect((decisions[1] as { message: string }).message).toContain("outside");
    // Nothing was put to the room.
    expect((await t.owner.get(`/api/projects/${t.projectId}/approvals`)).body.approvals).toHaveLength(0);
    await adapter.stop();
    room.disconnect();
  });

  it("offers no approvals for read-only runs or when the owner has not opted in", async () => {
    const t = await team();
    const driver = promptingDriver(async () => ok("ok"));
    const { adapter } = await adapterRoom(t, driver);
    const room = await t.owner.socket(t.projectId);
    const seen: MessageDTO[] = [];
    room.on("message:new", (m: MessageDTO) => seen.push(m));
    await t.requester.c.post(`/api/projects/${t.projectId}/messages`, { body: "@claude look around", clientNonce: nonce() });
    await waitFor(() => seen.filter((m) => m.kind === "agent").length === 1);
    expect(driver.offered).toEqual([false]);
    await adapter.stop();

    const t2 = await team();
    const d2 = promptingDriver(async () => ok("ok"));
    const r2 = await adapterRoom(t2, d2, { approvals: false });
    expect(r2.agent.capabilities.approvals).toBe(false);
    const room2 = await t2.owner.socket(t2.projectId);
    const seen2: MessageDTO[] = [];
    room2.on("message:new", (m: MessageDTO) => seen2.push(m));
    await t2.requester.c.post(`/api/projects/${t2.projectId}/messages`, { body: "@claude edit", clientNonce: nonce(), permission: "edit" });
    await waitFor(() => seen2.find((m) => m.kind === "agent"));
    expect(d2.offered).toEqual([false]);
    await r2.adapter.stop();
    room.disconnect();
    room2.disconnect();
  });

  it("cancelling the run while it waits denies the prompt and closes the request", async () => {
    const t = await team();
    const decisions: ToolPermissionDecision[] = [];
    const driver = promptingDriver(async (o) => {
      decisions.push(await o.approvals!.request({ toolName: "Bash", input: { command: "make deploy" }, toolUseId: null }));
      return { ...ok(""), outcome: o.signal.aborted ? "cancelled" : "succeeded" };
    });
    const { adapter } = await adapterRoom(t, driver);
    const sent = await t.requester.c.post(`/api/projects/${t.projectId}/messages`, { body: "@claude deploy", clientNonce: nonce(), permission: "edit" });
    const [p] = await pendingApprovals(t);
    await t.requester.c.post(`/api/dispatches/${sent.body.dispatches[0].id}/cancel`);
    await waitFor(() => decisions.length === 1);
    expect(decisions[0]).toMatchObject({ allow: false });
    await adapter.idle;
    const list = (await t.owner.get(`/api/projects/${t.projectId}/approvals`)).body.approvals as ApprovalDTO[];
    expect(list.find((a) => a.id === p!.id)?.status).toBe("cancelled");
    await adapter.stop();
  });

  it("denies when nobody decides in time (server expiry; the adapter also has a local backstop)", async () => {
    const t = await team();
    const decisions: ToolPermissionDecision[] = [];
    const driver = promptingDriver(async (o) => {
      decisions.push(await o.approvals!.request({ toolName: "Bash", input: { command: "make slow" }, toolUseId: null }));
      return ok("gave up");
    });
    // Server expiry fires at 1s; the adapter would give up on its own after 1s + APPROVAL_GRACE_MS.
    const { adapter } = await adapterRoom(t, driver, { approvalTimeoutMs: 1_000 });
    await t.requester.c.post(`/api/projects/${t.projectId}/messages`, { body: "@claude slow", clientNonce: nonce(), permission: "edit" });
    await waitFor(() => decisions.length === 1, 10_000);
    expect(decisions[0]).toMatchObject({ allow: false });
    expect((decisions[0] as { message: string }).message).toMatch(/decided in time/);
    await adapter.idle;
    await adapter.stop();
  });
});
