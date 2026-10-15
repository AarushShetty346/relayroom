import { randomUUID } from "node:crypto";
import { io as ioClient, type Socket } from "socket.io-client";
import {
  ADAPTER_NAMESPACE,
  ADAPTER_PROTOCOL_VERSION,
  type AdapterHello,
  type AdapterToServerEvents,
  type ApprovalDecision,
  type ApprovalRequest,
  type DispatchPayload,
  type RunComplete,
  type ServerToAdapterEvents,
  type ServerToClientEvents,
} from "@relayroom/protocol";
import type { Config } from "../src/config.js";
import { openDb, runMigrations, type DbHandle } from "../src/db/client.js";
import { buildServer, CSRF_HEADER, type RelayRoomServer } from "../src/app.js";

export const WEB_ORIGIN = "http://localhost:5173";

export interface TestServer {
  server: RelayRoomServer;
  baseUrl: string;
  dbh: DbHandle;
  stop(): Promise<void>;
}

/**
 * Boots a full server on an ephemeral port. Uses TEST_DATABASE_URL (a real Postgres; a throwaway
 * database is created per call) or falls back to in-process PGlite.
 */
export async function startTestServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  let url = "pglite:memory";
  let dropDb: (() => Promise<void>) | null = null;
  const base = process.env.TEST_DATABASE_URL;
  if (base) {
    const pg = (await import("pg")).default;
    const name = `rr_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin.end();
    const u = new URL(base);
    u.pathname = `/${name}`;
    url = u.toString();
    dropDb = async () => {
      const c = new pg.Client({ connectionString: base });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    };
  }
  const dbh = await openDb(url);
  await runMigrations(dbh);
  const config: Config = {
    databaseUrl: url,
    port: 0,
    host: "127.0.0.1",
    webOrigins: [WEB_ORIGIN],
    cookieSecure: false,
    logLevel: "silent",
    webDist: undefined,
    sessionTtlMs: 3600_000,
    orphanGraceMs: 90_000,
    sweepIntervalMs: 3600_000,
    ...overrides,
  };
  const server = await buildServer(config, dbh);
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    server,
    dbh,
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await server.close();
      await dbh.close();
      if (dropDb) await dropDb();
    },
  };
}

/** Minimal browser-like client: keeps the session cookie, sends the CSRF header. */
export class Client {
  cookie = "";
  constructor(public baseUrl: string) {}

  async req<T = any>(method: string, path: string, body?: unknown, opts: { csrf?: boolean } = {}): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { origin: WEB_ORIGIN };
    if (this.cookie) headers.cookie = this.cookie;
    if (opts.csrf !== false) headers[CSRF_HEADER] = "1";
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(this.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie();
    for (const c of set) {
      const [kv] = c.split(";");
      if (kv!.startsWith("rr_session=")) this.cookie = kv!.endsWith("=") ? "" : kv!;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (undefined as T) };
  }
  get<T = any>(p: string) {
    return this.req<T>("GET", p);
  }
  post<T = any>(p: string, b: unknown = {}) {
    return this.req<T>("POST", p, b);
  }
  patch<T = any>(p: string, b: unknown) {
    return this.req<T>("PATCH", p, b);
  }
  del<T = any>(p: string) {
    return this.req<T>("DELETE", p);
  }

  async signup(username: string, displayName = username) {
    const r = await this.post("/api/auth/signup", { username, displayName, password: "correct horse battery" });
    if (r.status !== 201) throw new Error(`signup failed ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.user as { id: string; username: string; displayName: string };
  }

  /** Real Socket.IO connection as this user, joined to a project room. */
  async socket(projectId: string): Promise<Socket<ServerToClientEvents, any>> {
    const s = ioClient(this.baseUrl, {
      transports: ["websocket"],
      extraHeaders: { cookie: this.cookie, origin: WEB_ORIGIN },
      reconnection: false,
      forceNew: true,
    });
    await new Promise<void>((resolve, reject) => {
      s.on("connect", () => resolve());
      s.on("connect_error", reject);
    });
    const r = await s.emitWithAck("room:join", { projectId });
    if (!r.ok) throw new Error(r.error);
    return s;
  }
}

export function nonce() {
  return randomUUID();
}

export function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type AdapterSocket = Socket<ServerToAdapterEvents, AdapterToServerEvents>;

/**
 * ADAPTER SIMULATION — a scripted stand-in for the local adapter, speaking the real wire protocol.
 * It does not run any coding agent; tests that use it prove server behaviour only, not provider
 * integration.
 */
export class SimulatedAdapter {
  socket!: AdapterSocket;
  received: DispatchPayload[] = [];
  cancels: string[] = [];
  revoked: string[] = [];
  decisions: ApprovalDecision[] = [];
  active = new Set<string>();

  constructor(
    private baseUrl: string,
    private token: string,
    private opts: { autoAccept?: boolean; maxPermission?: "read-only" | "edit" } = {},
  ) {}

  async connect(activeDispatchIds: string[] = []): Promise<{ ok: boolean; error?: string }> {
    this.socket = ioClient(this.baseUrl + ADAPTER_NAMESPACE, {
      transports: ["websocket"],
      auth: { token: this.token },
      reconnection: false,
      forceNew: true,
    }) as AdapterSocket;
    this.socket.on("dispatch", (p) => {
      this.received.push(p);
    });
    this.socket.on("dispatch:cancel", (p) => this.cancels.push(p.dispatchId));
    this.socket.on("revoked", (p) => this.revoked.push(p.reason));
    this.socket.on("approval:decision", (d) => this.decisions.push(d));
    await new Promise<void>((resolve, reject) => {
      this.socket.on("connect", () => resolve());
      this.socket.on("connect_error", reject);
    });
    const hello: AdapterHello = {
      protocolVersion: ADAPTER_PROTOCOL_VERSION,
      adapterVersion: "sim-0",
      provider: "custom",
      providerVersion: "simulation",
      capabilities: { progressEvents: true, cancel: true, edit: true, verified: false },
      maxPermission: this.opts.maxPermission ?? "edit",
      activeDispatchIds,
      journaledDispatchIds: [],
      repo: null,
    };
    return this.socket.emitWithAck("hello", hello);
  }

  accept(dispatchId: string) {
    return this.socket.emitWithAck("dispatch:accept", { dispatchId });
  }
  reject(dispatchId: string, reason: string) {
    return this.socket.emitWithAck("dispatch:reject", { dispatchId, reason });
  }
  event(dispatchId: string, seq: number, text: string) {
    return this.socket.emitWithAck("run:event", { dispatchId, seq, type: "status", text });
  }
  complete(dispatchId: string, partial: Partial<RunComplete> = {}) {
    const payload: RunComplete = {
      dispatchId,
      outcome: "succeeded",
      exitCode: 0,
      executionId: "sim-exec",
      finalText: "simulated reply",
      errorMessage: null,
      durationMs: 5,
      observed: { commands: [], baseCommit: null, git: null, diff: null, diffTruncated: false, baseCheck: null },
      reported: null,
      ...partial,
    };
    return this.socket.emitWithAck("run:complete", payload);
  }
  requestApproval(dispatchId: string, partial: Partial<ApprovalRequest> = {}) {
    const req: ApprovalRequest = {
      approvalId: randomUUID(),
      dispatchId,
      toolName: "Bash",
      summary: "$ npm install left-pad",
      detail: JSON.stringify({ command: "npm install left-pad" }),
      timeoutMs: 60_000,
      ...partial,
    };
    return this.socket.emitWithAck("approval:request", req).then((ack) => ({ ack, req }));
  }
  heartbeat(state: "idle" | "busy" = "idle", activeDispatchIds: string[] = []) {
    this.socket.emit("heartbeat", { state, activeDispatchIds, repo: null });
  }
  disconnect() {
    this.socket.disconnect();
  }
}

/** Creates owner + project + registered agent with a connected simulated adapter. */
export async function setupProjectWithAgent(ts: TestServer, handle = "claude") {
  const owner = new Client(ts.baseUrl);
  const ownerUser = await owner.signup("alice", "Alice");
  const p = await owner.post("/api/projects", { name: "Demo", description: "test" });
  const projectId = p.body.project.id as string;
  const a = await owner.post(`/api/projects/${projectId}/agents`, { handle, displayName: handle[0]!.toUpperCase() + handle.slice(1), provider: "claude-code" });
  const adapter = new SimulatedAdapter(ts.baseUrl, a.body.token);
  const hello = await adapter.connect();
  if (!hello.ok) throw new Error("hello failed " + hello.error);
  return { owner, ownerUser, projectId, agentId: a.body.agent.id as string, token: a.body.token as string, adapter };
}
