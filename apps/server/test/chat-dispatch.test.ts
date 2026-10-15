/**
 * Server behaviour for chat, routing and the dispatch queue.
 * Agents here are ADAPTER SIMULATIONS (see SimulatedAdapter): they prove the server side of the
 * protocol, not any real provider integration.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MessageDTO } from "@relayroom/protocol";
import { Client, SimulatedAdapter, delay, nonce, setupProjectWithAgent, startTestServer, waitFor, type TestServer } from "./helpers.js";

let ts: TestServer;
beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.stop();
});

let userCounter = 0;
async function freshProject(handle = "claude") {
  // Usernames must be unique per server; setupProjectWithAgent uses "alice".
  const owner = new Client(ts.baseUrl);
  const u = await owner.signup(`owner${++userCounter}`, `Owner ${userCounter}`);
  const projectId = (await owner.post("/api/projects", { name: "P" })).body.project.id as string;
  const a = await owner.post(`/api/projects/${projectId}/agents`, { handle, displayName: "Claude", provider: "claude-code" });
  const adapter = new SimulatedAdapter(ts.baseUrl, a.body.token);
  expect((await adapter.connect()).ok).toBe(true);
  return { owner, user: u, projectId, agentId: a.body.agent.id as string, token: a.body.token as string, adapter };
}

describe("durable real-time chat", () => {
  it("persists, broadcasts to room members, paginates in order", async () => {
    const { owner, projectId } = await freshProject();
    const s = await owner.socket(projectId);
    const got: MessageDTO[] = [];
    s.on("message:new", (m) => got.push(m));
    for (let i = 0; i < 7; i++) {
      const r = await owner.post(`/api/projects/${projectId}/messages`, { body: `msg ${i}`, clientNonce: nonce() });
      expect(r.status).toBe(201);
    }
    await waitFor(() => got.filter((m) => m.kind === "human").length === 7);
    const all = (await owner.get(`/api/projects/${projectId}/messages?limit=200`)).body.messages as MessageDTO[];
    const humans = all.filter((m) => m.kind === "human");
    expect(humans.map((m) => m.body)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `msg ${i}`));
    // seq strictly increasing
    const seqs = all.map((m) => BigInt(m.seq));
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]! > seqs[i - 1]!).toBe(true);

    const page1 = (await owner.get(`/api/projects/${projectId}/messages?limit=3`)).body;
    expect(page1.messages.map((m: MessageDTO) => m.body)).toEqual(["msg 4", "msg 5", "msg 6"]);
    expect(page1.hasMore).toBe(true);
    const page2 = (await owner.get(`/api/projects/${projectId}/messages?limit=3&before=${page1.messages[0].seq}`)).body;
    expect(page2.messages.map((m: MessageDTO) => m.body)).toEqual(["msg 1", "msg 2", "msg 3"]);
    // catch-up after reconnect
    const after = (await owner.get(`/api/projects/${projectId}/messages?after=${page2.messages[2].seq}`)).body;
    expect(after.messages.map((m: MessageDTO) => m.body)).toEqual(["msg 4", "msg 5", "msg 6"]);
    s.disconnect();
  });

  it("deduplicates retried sends by clientNonce", async () => {
    const { owner, projectId } = await freshProject();
    const n = nonce();
    const [a, b] = await Promise.all([
      owner.post(`/api/projects/${projectId}/messages`, { body: "once", clientNonce: n }),
      owner.post(`/api/projects/${projectId}/messages`, { body: "once", clientNonce: n }),
    ]);
    expect(a.body.message.id).toBe(b.body.message.id);
    const msgs = (await owner.get(`/api/projects/${projectId}/messages`)).body.messages as MessageDTO[];
    expect(msgs.filter((m) => m.body === "once")).toHaveLength(1);
  });

  it("supports replies and user mentions; rejects cross-project replies", async () => {
    const { owner, projectId } = await freshProject();
    const first = (await owner.post(`/api/projects/${projectId}/messages`, { body: "root", clientNonce: nonce() })).body.message;
    const reply = await owner.post(`/api/projects/${projectId}/messages`, {
      body: `@${owner.cookie ? "owner" : ""} replying`,
      replyToId: first.id,
      clientNonce: nonce(),
    });
    expect(reply.body.message.replyToId).toBe(first.id);
    const other = await freshProject();
    const bad = await other.owner.post(`/api/projects/${other.projectId}/messages`, { body: "x", replyToId: first.id, clientNonce: nonce() });
    expect(bad.status).toBe(400);
  });
});

describe("agent routing and dispatch", () => {
  it("only wakes mentioned agents; delivers dispatch; reply lands in the room", async () => {
    const { owner, projectId, adapter, token } = await freshProject("claude");
    const codexReg = await owner.post(`/api/projects/${projectId}/agents`, { handle: "codex", displayName: "Codex", provider: "codex" });
    const codex = new SimulatedAdapter(ts.baseUrl, codexReg.body.token);
    await codex.connect();
    const s = await owner.socket(projectId);
    const got: MessageDTO[] = [];
    s.on("message:new", (m) => got.push(m));

    await owner.post(`/api/projects/${projectId}/messages`, { body: "just chatting, no mentions", clientNonce: nonce() });
    const r = await owner.post(`/api/projects/${projectId}/messages`, { body: "@claude summarize the README", clientNonce: nonce() });
    expect(r.status).toBe(201);
    expect(r.body.dispatches).toHaveLength(1);
    const d = await waitFor(() => adapter.received[0]);
    expect(d.instruction).toBe("summarize the README");
    expect(d.permission).toBe("read-only");
    expect(d.requestedBy.username).toMatch(/^owner/);
    await delay(100);
    expect(codex.received).toHaveLength(0);

    expect((await adapter.accept(d.dispatchId)).ok).toBe(true);
    expect((await adapter.event(d.dispatchId, 0, "reading README.md")).ok).toBe(true);
    expect((await adapter.complete(d.dispatchId, { finalText: "The README describes X." })).ok).toBe(true);
    const reply = await waitFor(() => got.find((m) => m.kind === "agent"));
    expect(reply.body).toBe("The README describes X.");
    expect(reply.author).toMatchObject({ type: "agent", name: "Claude" });
    expect(reply.replyToId).toBe(r.body.message.id);
    expect(got.some((m) => m.kind === "event" && m.dispatchId === d.dispatchId)).toBe(true);
    void token;
    s.disconnect();
    codex.disconnect();
  });

  it("grants each dispatch at most once (duplicate accepts and re-delivery)", async () => {
    const { owner, projectId, adapter } = await freshProject();
    await owner.post(`/api/projects/${projectId}/messages`, { body: "@claude do it", clientNonce: nonce() });
    const d = await waitFor(() => adapter.received[0]);
    const results = await Promise.all([adapter.accept(d.dispatchId), adapter.accept(d.dispatchId), adapter.accept(d.dispatchId)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    // Simulate a reconnect: the adapter comes back still running the dispatch. It is not re-sent.
    adapter.disconnect();
    const again = new SimulatedAdapter(ts.baseUrl, (adapter as any).token);
    await again.connect([d.dispatchId]);
    await delay(200);
    expect(again.received).toHaveLength(0);
    expect((await again.accept(d.dispatchId)).ok).toBe(false);
    expect((await again.complete(d.dispatchId)).ok).toBe(true);
    // A duplicate completion is acknowledged without a second reply.
    expect((await again.complete(d.dispatchId)).ok).toBe(true);
    const msgs = (await owner.get(`/api/projects/${projectId}/messages`)).body.messages as MessageDTO[];
    expect(msgs.filter((m) => m.kind === "agent")).toHaveLength(1);
    again.disconnect();
  });

  it("re-sends a pending (never accepted) dispatch after reconnect", async () => {
    const { owner, projectId, adapter, token } = await freshProject();
    await owner.post(`/api/projects/${projectId}/messages`, { body: "@claude first", clientNonce: nonce() });
    const d = await waitFor(() => adapter.received[0]);
    adapter.disconnect();
    await delay(100);
    const again = new SimulatedAdapter(ts.baseUrl, token);
    await again.connect([]);
    const redelivered = await waitFor(() => again.received[0]);
    expect(redelivered.dispatchId).toBe(d.dispatchId);
    again.disconnect();
  });

  it("marks a run interrupted when the adapter restarts without it, and never re-runs it", async () => {
    const { owner, projectId, adapter, token } = await freshProject();
    const s = await owner.socket(projectId);
    const got: MessageDTO[] = [];
    s.on("message:new", (m) => got.push(m));
    await owner.post(`/api/projects/${projectId}/messages`, { body: "@claude long job", clientNonce: nonce() });
    const d = await waitFor(() => adapter.received[0]);
    await adapter.accept(d.dispatchId);
    adapter.disconnect();
    const again = new SimulatedAdapter(ts.baseUrl, token);
    await again.connect([]); // restarted process: nothing active
    await waitFor(() => got.find((m) => m.meta.notice === "run_interrupted"));
    const ds = (await owner.get(`/api/projects/${projectId}/dispatches`)).body.dispatches;
    expect(ds.find((x: { id: string }) => x.id === d.dispatchId).status).toBe("interrupted");
    await delay(150);
    expect(again.received).toHaveLength(0);
    // Human retry creates a new dispatch.
    const retry = await owner.post(`/api/dispatches/${d.dispatchId}/retry`, {});
    expect(retry.status).toBe(201);
    const nd = await waitFor(() => again.received[0]);
    expect(nd.dispatchId).not.toBe(d.dispatchId);
    expect(nd.instruction).toBe("long job");
    s.disconnect();
    again.disconnect();
  });

  it("queues behind a busy agent only after confirmation", async () => {
    const { owner, projectId, adapter } = await freshProject();
    await owner.post(`/api/projects/${projectId}/messages`, { body: "@claude one", clientNonce: nonce() });
    const d1 = await waitFor(() => adapter.received[0]);
    await adapter.accept(d1.dispatchId);
    const n = nonce();
    const blocked = await owner.post(`/api/projects/${projectId}/messages`, { body: "@claude two", clientNonce: n });
    expect(blocked.status).toBe(409);
    expect(blocked.body.needsConfirmation.reasons[0]).toMatch(/busy/);
    expect(blocked.body.message).toBeUndefined();
    const ok = await owner.post(`/api/projects/${projectId}/messages`, { body: "@claude two", clientNonce: n, confirmConcurrent: true });
    expect(ok.status).toBe(201);
    await delay(150);
    expect(adapter.received).toHaveLength(1); // not delivered while busy
    await adapter.complete(d1.dispatchId);
    const d2 = await waitFor(() => adapter.received[1]);
    expect(d2.instruction).toBe("two");
  });

  it("reports unavailable agents instead of dispatching", async () => {
    const { owner, projectId, adapter } = await freshProject();
    adapter.disconnect();
    await delay(100);
    const r = await owner.post(`/api/projects/${projectId}/messages`, { body: "@claude anyone there?", clientNonce: nonce() });
    expect(r.status).toBe(201);
    expect(r.body.dispatches).toHaveLength(0);
    expect(r.body.unavailable[0]).toMatchObject({ handle: "claude" });
    expect(r.body.unavailable[0].reason).toMatch(/offline/);
  });

  it("enforces acceptFrom=owner and the adapter's read-only cap", async () => {
    const owner = new Client(ts.baseUrl);
    await owner.signup(`own${++userCounter}`);
    const projectId = (await owner.post("/api/projects", { name: "X" })).body.project.id;
    const reg = await owner.post(`/api/projects/${projectId}/agents`, { handle: "private", displayName: "P", provider: "codex", acceptFrom: "owner" });
    const ad = new SimulatedAdapter(ts.baseUrl, reg.body.token, { maxPermission: "read-only" });
    await ad.connect();
    const inv = (await owner.post(`/api/projects/${projectId}/invites`, {})).body.invite;
    const mate = new Client(ts.baseUrl);
    await mate.signup(`mate${++userCounter}`);
    await mate.post("/api/invites/accept", { code: inv.code });
    const r = await mate.post(`/api/projects/${projectId}/messages`, { body: "@private hi", clientNonce: nonce() });
    expect(r.body.unavailable[0].reason).toMatch(/owner/);
    const r2 = await owner.post(`/api/projects/${projectId}/messages`, { body: "@private edit things", clientNonce: nonce(), permission: "edit" });
    expect(r2.body.unavailable[0].reason).toMatch(/read-only/);
    const r3 = await owner.post(`/api/projects/${projectId}/messages`, { body: "@private look only", clientNonce: nonce() });
    expect(r3.body.dispatches).toHaveLength(1);
    ad.disconnect();
  });

  it("adapter cannot act on another agent's dispatch", async () => {
    const a = await freshProject("alpha");
    const b = await freshProject("beta");
    await a.owner.post(`/api/projects/${a.projectId}/messages`, { body: "@alpha go", clientNonce: nonce() });
    const d = await waitFor(() => a.adapter.received[0]);
    expect((await b.adapter.accept(d.dispatchId)).ok).toBe(false);
    expect((await b.adapter.complete(d.dispatchId)).ok).toBe(false);
  });

  it("rejects malformed adapter payloads and unauthenticated adapters", async () => {
    const { adapter } = await freshProject();
    const bad = await adapter.socket.emitWithAck("run:event", { dispatchId: "not-a-uuid", seq: -1 } as never);
    expect(bad).toEqual({ ok: false, error: "malformed payload" });
    const intruder = new SimulatedAdapter(ts.baseUrl, "rr_agent_forged");
    await expect(intruder.connect()).rejects.toThrow(/unauthorized/);
  });

  it("revoking a credential disconnects the adapter and blocks reconnects", async () => {
    const { owner, agentId, adapter, token, projectId } = await freshProject();
    await owner.post(`/api/projects/${projectId}/messages`, { body: "@claude queued", clientNonce: nonce() });
    await waitFor(() => adapter.received[0]);
    expect((await owner.post(`/api/agents/${agentId}/revoke`)).status).toBe(200);
    await waitFor(() => adapter.revoked.length > 0);
    await expect(new SimulatedAdapter(ts.baseUrl, token).connect()).rejects.toThrow(/unauthorized/);
    const agents = (await owner.get(`/api/projects/${projectId}/agents`)).body.agents;
    expect(agents[0].status).toBe("offline");
    expect(agents[0].revokedAt).not.toBeNull();
    const ds = (await owner.get(`/api/projects/${projectId}/dispatches`)).body.dispatches;
    expect(ds[0].status).toBe("cancelled");
  });

  it("token rotation invalidates the old token", async () => {
    const { owner, agentId, token } = await freshProject();
    const rot = await owner.post(`/api/agents/${agentId}/rotate-token`);
    expect(rot.body.token).not.toBe(token);
    await expect(new SimulatedAdapter(ts.baseUrl, token).connect()).rejects.toThrow(/unauthorized/);
    const fresh = new SimulatedAdapter(ts.baseUrl, rot.body.token);
    expect((await fresh.connect()).ok).toBe(true);
    fresh.disconnect();
  });

  it("cancels pending dispatches directly and signals running ones to the adapter", async () => {
    const { owner, projectId, adapter } = await freshProject();
    await owner.post(`/api/projects/${projectId}/messages`, { body: "@claude a", clientNonce: nonce() });
    const d = await waitFor(() => adapter.received[0]);
    await adapter.accept(d.dispatchId);
    const c = await owner.post(`/api/dispatches/${d.dispatchId}/cancel`);
    expect(c.body.status).toBe("cancel_requested");
    await waitFor(() => adapter.cancels.includes(d.dispatchId));
    await adapter.complete(d.dispatchId, { outcome: "cancelled", finalText: "", exitCode: null });
    const ds = (await owner.get(`/api/projects/${projectId}/dispatches`)).body.dispatches;
    expect(ds[0].status).toBe("cancelled");
  });

  it("agent directory exposes no credentials or paths", async () => {
    const { owner, projectId } = await freshProject();
    const agents = (await owner.get(`/api/projects/${projectId}/agents`)).body.agents;
    const json = JSON.stringify(agents);
    expect(json).not.toMatch(/rr_agent_/);
    expect(json).not.toMatch(/tokenHash|token_hash/);
    expect(agents[0].status).toBe("online");
  });
});
