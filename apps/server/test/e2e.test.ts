/**
 * End-to-end: human message → real Adapter runtime (journal, policy, git, redaction, reconnect) →
 * server → shared room. The provider itself is a SCRIPTED DRIVER (simulation): this proves the
 * RelayRoom pipeline, not Claude Code or Codex. Real-provider runs are covered by scripts/smoke-real-provider.ts.
 */
import { removeTemp } from "./tmp.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Adapter, validateProjectDir, type AdapterConfig, type ProviderDriver, type RunOptions, type RunResult } from "@relayroom/adapter";
import type { MessageDTO, TaskDetailDTO, TaskDTO } from "@relayroom/protocol";
import { Client, delay, nonce, startTestServer, waitFor, type TestServer } from "./helpers.js";

let ts: TestServer;
const dirs: string[] = [];
beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.stop();
  for (const d of dirs) removeTemp(d);
});

const quietLog = { info() {}, warn() {}, error() {} };

function repo(): string {
  const d = validateProjectDir(mkdtempSync(path.join(tmpdir(), "rr-e2e-")));
  dirs.push(d);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: d });
  g("init", "-q", "-b", "main");
  writeFileSync(path.join(d, "auth.ts"), "export const check = () => true;\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  return d;
}

/** Scripted provider: behaviour is supplied per test. */
function scriptedDriver(script: (o: RunOptions) => Promise<RunResult>): ProviderDriver & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "claude-code",
    label: "Scripted",
    capabilities: { progressEvents: true, cancel: true, edit: true },
    prompts,
    async detect() {
      return { bin: "scripted", version: "scripted-1" };
    },
    run(o) {
      prompts.push(o.prompt);
      return script(o);
    },
  };
}

const ok = (finalText: string, extra: Partial<RunResult> = {}): RunResult => ({
  outcome: "succeeded",
  exitCode: 0,
  executionId: "exec-1",
  finalText,
  errorMessage: null,
  commands: [],
  permissionDenials: [],
  ...extra,
});

let n = 0;
async function room(maxPermission: "read-only" | "edit" = "edit", extra: Partial<AdapterConfig> = {}) {
  const human = new Client(ts.baseUrl);
  const user = await human.signup(`human${++n}`, `Human ${n}`);
  const projectId = (await human.post("/api/projects", { name: "E2E" })).body.project.id as string;
  const reg = await human.post(`/api/projects/${projectId}/agents`, { handle: "claude", displayName: "Claude", provider: "claude-code" });
  const projectDir = repo();
  const cfg: AdapterConfig = {
    serverUrl: ts.baseUrl,
    projectDir,
    provider: "claude-code",
    maxPermission,
    timeoutMs: 60_000,
    worktrees: false,
    token: reg.body.token,
    journalPath: path.join(projectDir, "..", `${path.basename(projectDir)}-journal.json`),
    ...extra,
  };
  dirs.push(cfg.journalPath);
  const socket = await human.socket(projectId);
  const seen: MessageDTO[] = [];
  socket.on("message:new", (m) => seen.push(m));
  return { human, user, projectId, agentId: reg.body.agent.id as string, cfg, projectDir, seen, socket };
}

async function online(human: Client, projectId: string) {
  for (let i = 0; i < 100; i++) {
    const a = (await human.get(`/api/projects/${projectId}/agents`)).body.agents[0];
    if (a.status === "online") return a;
    await delay(50);
  }
  throw new Error("agent never came online");
}

describe("human → agent → human through the real adapter runtime", () => {
  it("routes a mention, streams progress, and posts the agent's actual reply", async () => {
    const r = await room();
    const driver = scriptedDriver(async (o) => {
      o.onEvent({ type: "status", text: "reading files" });
      o.onEvent({ type: "command", text: `$ cat ${path.join(o.cwd, "auth.ts")}` });
      return ok("The auth module exports `check`.", { commands: [{ command: "cat auth.ts", exitCode: 0, ok: true, source: "scripted" }] });
    });
    const adapter = new Adapter(r.cfg, driver, quietLog);
    await adapter.start();
    const agent = await online(r.human, r.projectId);
    expect(agent.providerVersion).toBe("scripted-1");
    expect(agent.capabilities.verified).toBe(false); // no self-test recorded
    expect(agent.repo.branch).toBe("main");

    const runEvents: { text: string }[] = [];
    r.socket.on("run:event", (e) => runEvents.push(e));
    const sent = await r.human.post(`/api/projects/${r.projectId}/messages`, { body: "@claude what does auth.ts export?", clientNonce: nonce() });
    expect(sent.status).toBe(201);

    const reply = await waitFor(() => r.seen.find((m) => m.kind === "agent"));
    expect(reply.body).toBe("The auth module exports `check`.");
    expect(reply.replyToId).toBe(sent.body.message.id);
    expect(reply.meta).toMatchObject({ outcome: "succeeded", exitCode: 0, branch: "main" });
    // Prompt contained the request, the requester, and the read-only permission.
    expect(driver.prompts[0]).toContain("what does auth.ts export?");
    expect(driver.prompts[0]).toContain(`@${r.user.username}`);
    expect(driver.prompts[0]).toContain("read-only");
    // Progress events reached the room, with local paths scrubbed.
    await waitFor(() => runEvents.length >= 3);
    const cmd = runEvents.find((e) => e.text.startsWith("$ cat"))!;
    expect(cmd.text).not.toContain(r.projectDir);
    expect(cmd.text).toMatch(/\$ cat \.[\\/]auth\.ts/);

    await adapter.stop();
    r.socket.disconnect();
  });

  it("runs an assigned task, records an observed+reported handoff, and waits for human review", async () => {
    const r = await room("edit");
    const driver = scriptedDriver(async (o) => {
      writeFileSync(path.join(o.cwd, "auth.ts"), "export const check = (t: string) => t.length > 0 && !expired(t);\n");
      return ok(
        'Validated expiry.\n\n```relayroom-handoff\n{"summary":"Added expiry validation","workCompleted":["auth.ts: check expiry"],"testsRun":[],"testResults":"No tests were run.","unresolvedFailures":[],"limitations":["expired() is not implemented"],"nextAction":"Implement expired()","decisions":["Validate expiry before issuer"],"openQuestions":["Which clock skew is acceptable?"]}\n```',
        { commands: [] },
      );
    });
    const adapter = new Adapter(r.cfg, driver, quietLog);
    await adapter.start();
    await online(r.human, r.projectId);

    const task = (await r.human.post(`/api/projects/${r.projectId}/tasks`, {
      title: "Validate token expiry",
      description: "Reject expired tokens",
      acceptanceCriteria: ["Expired tokens are rejected", "Interface unchanged"],
    })).body.task as TaskDTO;
    const assigned = await r.human.post(`/api/tasks/${task.id}/assign`, { assignee: { type: "agent", id: r.agentId }, permission: "edit" });
    expect(assigned.status).toBe(200);

    const reply = await waitFor(() => r.seen.find((m) => m.kind === "agent" && m.taskId === task.id), 10_000);
    expect(reply.body).toBe("Validated expiry.");
    expect(driver.prompts[0]).toContain("Acceptance criteria:");
    expect(driver.prompts[0]).toContain("relayroom-handoff");

    const detail = (await r.human.get(`/api/tasks/${task.id}`)).body as TaskDetailDTO;
    expect(detail.task.status).toBe("awaiting_review");
    expect(detail.task.branch).toBe("main");
    const h = detail.handoffs[0]!;
    expect(h.handoff.observed.filesChanged).toEqual([{ path: "auth.ts", status: "M" }]);
    expect(h.handoff.observed.provider).toBe("claude-code");
    expect(h.handoff.reported?.testResults).toBe("No tests were run.");
    expect(h.handoff.acceptanceCriteria).toEqual(["Expired tokens are rejected", "Interface unchanged"]);
    expect(h.diff).toContain("expired(t)");
    expect(detail.history.map((x) => x.to)).toEqual(["queued", "assigned", "running", "awaiting_review"]);

    // Agent suggestions are stored, but as unverified.
    const mem = (await r.human.get(`/api/projects/${r.projectId}/memory`)).body.entries;
    expect(mem.find((m: { title: string }) => m.title === "Validate expiry before issuer").status).toBe("suggested");
    expect(mem.find((m: { kind: string }) => m.kind === "open_question").status).toBe("assumption");

    // An agent can never complete a task; a human review does.
    const done = await r.human.post(`/api/tasks/${task.id}/transition`, { to: "completed", note: "LGTM" });
    expect(done.body.task.status).toBe("completed");

    await adapter.stop();
    r.socket.disconnect();
  });

  it("local policy wins: a read-only adapter refuses edit work", async () => {
    const r = await room("read-only");
    const driver = scriptedDriver(async () => ok("should not run"));
    const adapter = new Adapter(r.cfg, driver, quietLog);
    await adapter.start();
    await online(r.human, r.projectId);
    // The server already knows the cap from hello, so it reports the agent as unavailable for edits.
    const res = await r.human.post(`/api/projects/${r.projectId}/messages`, { body: "@claude rewrite everything", clientNonce: nonce(), permission: "edit" });
    expect(res.body.unavailable[0].reason).toMatch(/read-only/);
    expect(driver.prompts).toHaveLength(0);
    await adapter.stop();
    r.socket.disconnect();
  });

  it("a provider that can only run read-only on its machine is refused edit work up front", async () => {
    const r = await room("edit");
    const base = scriptedDriver(async () => ok("read-only answer"));
    const driver = { ...base, prompts: base.prompts, detect: async () => ({ bin: "scripted", version: "scripted-1", canEdit: false, editNote: "sandbox is read-only here" }) };
    const adapter = new Adapter(r.cfg, driver, quietLog);
    await adapter.start();
    const agent = await online(r.human, r.projectId);
    expect(agent.maxPermission).toBe("read-only");
    expect(agent.capabilities.edit).toBe(false);
    const res = await r.human.post(`/api/projects/${r.projectId}/messages`, { body: "@claude edit the file", clientNonce: nonce(), permission: "edit" });
    expect(res.body.unavailable[0].reason).toMatch(/can only run read-only/);
    expect(driver.prompts).toHaveLength(0);
    // Read-only work still runs.
    await r.human.post(`/api/projects/${r.projectId}/messages`, { body: "@claude just look", clientNonce: nonce() });
    await waitFor(() => r.seen.find((m) => m.kind === "agent"));
    expect(driver.prompts).toHaveLength(1);
    await adapter.stop();
    r.socket.disconnect();
  });

  it("allowedRequesters is enforced by the adapter even when the server allows the member", async () => {
    const r = await room("edit", { allowedRequesters: ["somebody-else"] });
    const driver = scriptedDriver(async () => ok("should not run"));
    const adapter = new Adapter(r.cfg, driver, quietLog);
    await adapter.start();
    await online(r.human, r.projectId);
    await r.human.post(`/api/projects/${r.projectId}/messages`, { body: "@claude hi", clientNonce: nonce() });
    const notice = await waitFor(() => r.seen.find((m) => m.meta.notice === "dispatch_rejected"));
    expect(notice.body).toMatch(/not on this adapter's allowed requester list/);
    expect(driver.prompts).toHaveLength(0);
    await adapter.stop();
    r.socket.disconnect();
  });

  it("cancels a running execution end to end", async () => {
    const r = await room();
    const driver = scriptedDriver(
      (o) =>
        new Promise<RunResult>((resolve) => {
          o.onEvent({ type: "status", text: "working slowly" });
          o.signal.addEventListener("abort", () => resolve({ ...ok(""), outcome: "cancelled", exitCode: null, errorMessage: "Cancelled by request" }));
        }),
    );
    const adapter = new Adapter(r.cfg, driver, quietLog);
    await adapter.start();
    await online(r.human, r.projectId);
    const sent = await r.human.post(`/api/projects/${r.projectId}/messages`, { body: "@claude long task", clientNonce: nonce() });
    const dispatchId = sent.body.dispatches[0].id;
    await waitFor(() => driver.prompts.length === 1);
    await waitFor(() => r.seen.find((m) => m.kind === "event" && m.dispatchId === dispatchId));
    const c = await r.human.post(`/api/dispatches/${dispatchId}/cancel`);
    expect(c.body.status).toBe("cancel_requested");
    const reply = await waitFor(() => r.seen.find((m) => m.kind === "agent" && m.dispatchId === dispatchId));
    expect(reply.body).toMatch(/cancelled/i);
    expect(reply.meta.outcome).toBe("cancelled");
    await adapter.stop();
    r.socket.disconnect();
  });

  it("a completion produced while the server was unreachable is delivered after restart, once", async () => {
    const r = await room();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const driver = scriptedDriver(async () => {
      await gate;
      return ok("finished while offline");
    });
    const a1 = new Adapter(r.cfg, driver, quietLog);
    await a1.start();
    await online(r.human, r.projectId);
    await r.human.post(`/api/projects/${r.projectId}/messages`, { body: "@claude work", clientNonce: nonce() });
    await waitFor(() => driver.prompts.length === 1);
    // Cut the network: the server sees the adapter go away mid-run.
    (a1 as unknown as { socket: { io: { engine: { close(): void } }; disconnect(): void } }).socket.disconnect();
    release();
    await a1.idle; // the result is written to the local journal because it could not be sent
    // A new adapter process starts with the same journal: it reports nothing active,
    // the server marks the run interrupted, then the journaled result arrives late.
    const a2 = new Adapter(r.cfg, scriptedDriver(async () => ok("must not re-run")), quietLog);
    await a2.start();
    const reply = await waitFor(() => r.seen.find((m) => m.kind === "agent"), 10_000);
    expect(reply.body).toBe("finished while offline");
    expect(reply.meta.late).toBe(true);
    await delay(300);
    expect(r.seen.filter((m) => m.kind === "agent")).toHaveLength(1);
    expect(r.seen.some((m) => m.meta.notice === "run_interrupted")).toBe(true);
    await a1.stop();
    await a2.stop();
    r.socket.disconnect();
  });
});
