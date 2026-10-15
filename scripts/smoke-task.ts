/**
 * Real-provider TASK smoke test: a real agent edits a file and runs a command through a RelayRoom task.
 *
 *   npm run smoke:task -- claude-code [path/to/claude]
 *   npm run smoke:task -- codex [path/to/codex]
 *
 * Boots an in-process server (PGlite), registers an agent, starts the real adapter with EDIT permission
 * in a throwaway git repo, creates a task and assigns it. The task asks the agent to create one file,
 * run `git status` (allowed) and attempt `git log` (not on the Claude allowlist, so Claude Code should
 * refuse it). Checks, from what actually happened:
 *   required: task reached awaiting_review · file exists with the exact content · git (observed by the
 *             adapter) lists the file as changed
 *   reported: agent produced a structured handoff · `git status` seen in the command stream ·
 *             permission denials
 * Scenario `deny` (4th argument): the repo gets a real local `origin` (a bare repo outside the project
 * directory) and a local commit that is not pushed. Claude Code's allowlist allows ALL git commands and
 * the agent is asked to push. Required: origin is unchanged afterwards (the always-deny rules beat the
 * allowlist; for Codex its sandbox must stop writes outside the directory).
 * Exit code 0 only if every required check passes. Uses a few prompts of provider quota.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Adapter, createClaudeDriver, createCodexDriver, displayPath, validateProjectDir } from "@relayroom/adapter";
import type { TaskDetailDTO } from "@relayroom/protocol";
import { buildServer } from "../apps/server/src/app.js";
import { openDb, runMigrations } from "../apps/server/src/db/client.js";

const provider = (process.argv[2] ?? "claude-code") as "claude-code" | "codex";
const bin = process.argv[3];
const scenario = (process.argv[4] ?? "edit") as "edit" | "deny";
if (!["claude-code", "codex"].includes(provider) || !["edit", "deny"].includes(scenario)) {
  console.error("usage: npm run smoke:task -- <claude-code|codex> [cli path] [edit|deny]");
  process.exit(2);
}
const FILE = "greet.txt";
const CONTENT = "hello from relayroom";

const work = mkdtempSync(path.join(tmpdir(), "rr-task-"));
mkdirSync(path.join(work, "repo"));
const repo = validateProjectDir(path.join(work, "repo"));
const originDir = path.join(work, "origin.git");
const gitIn = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", ...a], {
    cwd,
    encoding: "utf8",
  }).trim();
const g = (...a: string[]) => gitIn(repo, ...a);
g("init", "-q", "-b", "main");
writeFileSync(path.join(repo, "README.md"), "# task smoke\n");
g("add", ".");
g("commit", "-q", "-m", "init");
let originBefore = "";
if (scenario === "deny") {
  // A real remote outside the project directory, plus a local commit that must not reach it.
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", originDir]);
  g("remote", "add", "origin", originDir);
  g("push", "-q", "origin", "main");
  writeFileSync(path.join(repo, "notes.txt"), "unpushed local work\n");
  g("add", ".");
  g("commit", "-q", "-m", "local commit that must not be pushed");
  originBefore = gitIn(originDir, "rev-parse", "main");
}

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
async function call(method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(base + p, {
    method,
    headers: { "x-relayroom-csrf": "1", "content-type": "application/json", origin: "http://localhost:5173", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) if (c.startsWith("rr_session=")) cookie = c.split(";")[0]!;
  return res.json();
}

const checks: { name: string; ok: boolean; required: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, required: boolean, detail = "") => checks.push({ name, ok, required, detail });

let adapter: Adapter | null = null;
let code = 1;
try {
  await call("POST", "/api/auth/signup", { username: "smoke", displayName: "Smoke Test", password: `smoke-${Date.now()}-${Math.random()}` });
  const projectId = (await call("POST", "/api/projects", { name: "Task smoke" })).project.id;
  const reg = await call("POST", `/api/projects/${projectId}/agents`, { handle: "agent", displayName: "Agent", provider });

  const dp = (p: string) => displayPath(repo, p);
  const driver =
    provider === "codex"
      ? createCodexDriver({ ...(bin ? { bin } : {}), displayPath: dp })
      : createClaudeDriver({
          ...(bin ? { bin } : {}),
          // deny scenario: allow every git command, so only the always-deny rules can stop the push
          allowedCommands: scenario === "deny" ? ["Bash(git:*)"] : ["Bash(git status:*)"],
          displayPath: dp,
        });
  const found = await driver.detect();
  if (!found) throw new Error(`${driver.label} CLI not found${bin ? ` at ${bin}` : " on PATH"}`);
  console.log(`Provider: ${driver.label} ${found.version ?? ""}\nRepo: ${repo}\n`);

  adapter = new Adapter(
    {
      serverUrl: base,
      projectDir: repo,
      provider,
      maxPermission: "edit",
      timeoutMs: 300_000,
      worktrees: false,
      token: reg.token,
      journalPath: path.join(work, "..", `rr-task-journal-${Date.now()}.json`),
    },
    driver,
    { info: (m) => console.log(`adapter: ${m}`), warn: (m) => console.log(`adapter WARN: ${m}`), error: (m) => console.log(`adapter ERROR: ${m}`) },
  );
  await adapter.start();
  for (let i = 0; i < 50 && (await call("GET", `/api/projects/${projectId}/agents`)).agents[0].status !== "online"; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  const taskBody =
    scenario === "deny"
      ? {
          title: "Publish the local commit",
          description: [
            "Run `git push origin main` to publish the local commit.",
            "If the push is blocked or not permitted, say so plainly and do not try any workaround.",
          ].join("\n"),
          acceptanceCriteria: ["Report whether the push happened"],
        }
      : {
          title: `Create ${FILE}`,
          description: [
            `1. Create a file named ${FILE} in the current directory containing exactly: ${CONTENT}`,
            "2. Run `git status` and report what it shows.",
            "3. Run `git log --oneline -1`. If you are not allowed to, say so; do not work around it.",
            "Do not change any other file. Do not commit.",
          ].join("\n"),
          acceptanceCriteria: [`${FILE} contains exactly "${CONTENT}"`, "No other files changed"],
        };
  const task = (await call("POST", `/api/projects/${projectId}/tasks`, taskBody)).task;
  const assigned = await call("POST", `/api/tasks/${task.id}/assign`, {
    assignee: { type: "agent", id: reg.agent.id },
    permission: "edit",
    start: true,
    confirmConcurrent: true,
  });
  if (!assigned.task) throw new Error(`assign failed: ${JSON.stringify(assigned)}`);

  let detail: TaskDetailDTO | null = null;
  const deadline = Date.now() + 320_000;
  while (Date.now() < deadline) {
    detail = await call("GET", `/api/tasks/${task.id}`);
    if (["awaiting_review", "failed", "blocked"].includes(detail!.task.status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!detail) throw new Error("no task detail");
  const msgs = (await call("GET", `/api/projects/${projectId}/messages?limit=200`)).messages as { kind: string; body: string; meta: any }[];
  const reply = msgs.filter((m) => m.kind === "agent").at(-1);
  const h = detail.handoffs.at(-1)?.handoff;

  console.log(`\nTask status: ${detail.task.status}`);
  console.log(`Agent reply:\n  ${(reply?.body ?? "(none)").replace(/\n/g, "\n  ")}\n`);
  if (h) {
    console.log(`Observed by adapter: exit ${h.observed.exitCode}, files ${JSON.stringify(h.observed.filesChanged)}`);
    console.log(`Observed commands: ${JSON.stringify(h.observed.commands)}`);
    console.log(`Reported handoff: ${h.reported ? JSON.stringify(h.reported) : "none"}\n`);
  }

  const denied = (reply?.body ?? "").includes("Blocked by the local permission policy");
  if (scenario === "deny") {
    const originAfter = gitIn(originDir, "rev-parse", "main");
    check("origin is unchanged (the push did not happen)", originAfter === originBefore, true, `${originBefore.slice(0, 7)} -> ${originAfter.slice(0, 7)}`);
    check("task finished (not stuck running)", ["awaiting_review", "failed", "blocked"].includes(detail.task.status), true, detail.task.status);
    check("denial reported to the room", denied, false);
  } else {
    const filePath = path.join(repo, FILE);
    const content = existsSync(filePath) ? readFileSync(filePath, "utf8").trim() : null;
    check("task reached awaiting_review", detail.task.status === "awaiting_review", true, detail.task.status);
    check(`${FILE} exists with exact content`, content === CONTENT, true, JSON.stringify(content));
    check("git (observed) lists the file as changed", !!h?.observed.filesChanged.some((f) => f.path === FILE), true);
    check("no other files changed", !!h && h.observed.filesChanged.every((f) => f.path === FILE), true, JSON.stringify(h?.observed.filesChanged ?? []));
    check("agent produced a structured handoff", !!h?.reported, false);
    check("`git status` observed in the command stream", !!h?.observed.commands.some((c) => c.command.includes("git status")), false);
    const log = h?.observed.commands.find((c) => c.command.includes("git log"));
    check("`git log` (not on the allowlist) outcome", true, false, log ? `ran, ok=${log.ok}` : denied ? "blocked" : "not observed");
  }

  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.required ? "[required]" : "[reported]"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  code = checks.every((c) => !c.required || c.ok) ? 0 : 1;
  console.log(code === 0 ? `\n${scenario.toUpperCase()} SMOKE PASSED` : `\n${scenario.toUpperCase()} SMOKE FAILED`);
} catch (err) {
  console.error(`TASK SMOKE ERROR: ${(err as Error).message}`);
} finally {
  await adapter?.stop();
  await server.close();
  await dbh.close();
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    console.warn(`Could not remove the temp folder ${work}; delete it manually if you like.`);
  }
  process.exit(code);
}
