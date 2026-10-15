/**
 * Real-provider smoke test: the whole RelayRoom path with a REAL coding agent CLI.
 *
 *   npm run smoke -- claude-code [path/to/claude]
 *   npm run smoke -- codex [path/to/codex]
 *
 * Boots an in-process server (PGlite, no Docker), registers an agent, starts the real adapter with the
 * real provider driver against a throwaway git repo, sends one read-only @mention asking for a fixed
 * marker, and waits for the agent's reply in the room. Exit code 0 only if the actual reply contains
 * the marker. Uses one small prompt of provider quota. Credentials stay with the provider CLI.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { io } from "socket.io-client";
import { Adapter, createClaudeDriver, createCodexDriver, validateProjectDir, displayPath } from "@relayroom/adapter";
import type { MessageDTO } from "@relayroom/protocol";
import { buildServer } from "../apps/server/src/app.js";
import { openDb, runMigrations } from "../apps/server/src/db/client.js";

const provider = (process.argv[2] ?? "claude-code") as "claude-code" | "codex";
const bin = process.argv[3];
if (!["claude-code", "codex"].includes(provider)) {
  console.error("usage: npm run smoke -- <claude-code|codex> [cli path]");
  process.exit(2);
}
const MARKER = "RELAYROOM_SMOKE_OK";

const work = mkdtempSync(path.join(tmpdir(), "rr-smoke-"));
const repo = validateProjectDir(work);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
writeFileSync(path.join(repo, "README.md"), "# smoke\n");
execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "add", "."], { cwd: repo });
execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: repo });

const dbh = await openDb("pglite:memory");
await runMigrations(dbh);
const server = await buildServer(
  {
    databaseUrl: "pglite:memory",
    port: 0,
    host: "127.0.0.1",
    webOrigins: ["http://localhost:5173"],
    cookieSecure: false,
    logLevel: "warn",
    webDist: undefined,
    sessionTtlMs: 3600_000,
    orphanGraceMs: 90_000,
    sweepIntervalMs: 15_000,
  },
  dbh,
);
await server.app.listen({ port: 0, host: "127.0.0.1" });
const addr = server.app.server.address();
const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

let cookie = "";
async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(base + p, {
    method,
    headers: { "x-relayroom-csrf": "1", "content-type": "application/json", origin: "http://localhost:5173", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) if (c.startsWith("rr_session=")) cookie = c.split(";")[0]!;
  return (await res.json()) as any;
}

let code = 1;
let adapter: Adapter | null = null;
try {
  await call("POST", "/api/auth/signup", { username: "smoke", displayName: "Smoke Test", password: `smoke-${Date.now()}-${Math.random()}` });
  const projectId = (await call("POST", "/api/projects", { name: "Smoke" })).project.id;
  const reg = await call("POST", `/api/projects/${projectId}/agents`, { handle: "agent", displayName: "Agent", provider });

  const sock = io(base, { transports: ["websocket"], extraHeaders: { cookie, origin: "http://localhost:5173" }, forceNew: true });
  await new Promise<void>((r, j) => (sock.on("connect", () => r()), sock.on("connect_error", j)));
  await sock.emitWithAck("room:join", { projectId });
  const reply = new Promise<MessageDTO>((resolve) => sock.on("message:new", (m: MessageDTO) => m.kind === "agent" && resolve(m)));
  sock.on("run:event", (e: { type: string; text: string }) => console.log(`  [${e.type}] ${e.text.slice(0, 160)}`));

  const dp = (p: string) => displayPath(repo, p);
  const driver = provider === "codex" ? createCodexDriver({ ...(bin ? { bin } : {}), displayPath: dp }) : createClaudeDriver({ ...(bin ? { bin } : {}), displayPath: dp });
  const found = await driver.detect();
  if (!found) throw new Error(`${driver.label} CLI not found${bin ? ` at ${bin}` : " on PATH"}`);
  console.log(`Provider: ${driver.label} ${found.version ?? ""}`);
  adapter = new Adapter(
    { serverUrl: base, projectDir: repo, provider, maxPermission: "read-only", timeoutMs: 180_000, worktrees: false, token: reg.token, journalPath: path.join(work, "..", `rr-smoke-journal-${Date.now()}.json`) },
    driver,
    { info: (m) => console.log(`adapter: ${m}`), warn: (m) => console.log(`adapter WARN: ${m}`), error: (m) => console.log(`adapter ERROR: ${m}`) },
  );
  await adapter.start();
  for (let i = 0; i < 50; i++) {
    const a = (await call("GET", `/api/projects/${projectId}/agents`)).agents[0];
    if (a.status === "online") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await call("POST", `/api/projects/${projectId}/messages`, { body: `@agent Do not use any tools. Reply with exactly: ${MARKER}`, clientNonce: crypto.randomUUID() });
  const m = await Promise.race([reply, new Promise<never>((_, j) => setTimeout(() => j(new Error("no reply within 200s")), 200_000))]);
  console.log(`\nAgent reply in the room: ${JSON.stringify(m.body.slice(0, 300))}`);
  console.log(`Outcome: ${m.meta.outcome} · exit ${m.meta.exitCode} · ${m.meta.durationMs}ms`);
  code = m.meta.outcome === "succeeded" && m.body.includes(MARKER) ? 0 : 1;
  console.log(code === 0 ? "\nSMOKE PASSED: real provider output reached the shared room." : "\nSMOKE FAILED: see the reply above (often: the CLI is not logged in).");
  sock.close();
} catch (err) {
  console.error(`SMOKE ERROR: ${(err as Error).message}`);
} finally {
  await adapter?.stop();
  await server.close();
  await dbh.close();
  // Windows can keep the folder locked briefly after the provider exits; cleanup must not change the result.
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    console.warn(`Could not remove the temp folder ${work}; delete it manually if you like.`);
  }
  process.exit(code);
}
