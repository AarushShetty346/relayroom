import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { validateProjectDir } from "./paths.js";

const FileConfig = z.object({
  serverUrl: z.string().url(),
  projectDir: z.string().min(1),
  provider: z.enum(["claude-code", "codex"]),
  /** Optional explicit path to the provider CLI. Defaults to `claude` / `codex` on PATH. */
  providerBin: z.string().optional(),
  /** Hard local cap. A dispatch asking for more is rejected. */
  maxPermission: z.enum(["read-only", "edit"]).default("read-only"),
  /** If set, only these RelayRoom usernames may dispatch work to this adapter. */
  allowedRequesters: z.array(z.string()).optional(),
  /** Claude Code permission rules for shell commands allowed in edit mode, e.g. "Bash(npm test:*)". */
  allowedCommands: z.array(z.string()).optional(),
  timeoutMinutes: z.number().min(1).max(240).default(30),
  /**
   * Human-in-the-loop approvals (Claude Code only): in edit runs, actions outside the allowlist are
   * put to the room (requester, agent owner or project owner decides) instead of being denied.
   * Still capped locally: read-only runs, paths outside the directory and the always-denied commands
   * are never approvable. Off by default.
   */
  approvals: z.boolean().default(false),
  /** How long a run waits for a human decision before the action is denied. */
  approvalTimeoutMinutes: z.number().min(1).max(60).default(10),
  /** Run edit-permission task dispatches in a dedicated git worktree + branch per task. */
  worktrees: z.boolean().default(false),
  /** Token file path (alternative to the RELAYROOM_AGENT_TOKEN environment variable). */
  tokenFile: z.string().optional(),
  /** Where local state (journal) is kept. Default: ~/.relayroom */
  stateDir: z.string().optional(),
});

export interface AdapterConfig {
  serverUrl: string;
  projectDir: string;
  provider: "claude-code" | "codex";
  providerBin?: string;
  maxPermission: "read-only" | "edit";
  allowedRequesters?: string[];
  allowedCommands?: string[];
  timeoutMs: number;
  /** Ask the room before denying actions outside the allowlist (edit runs, supporting drivers only). */
  approvals?: boolean;
  approvalTimeoutMs?: number;
  worktrees: boolean;
  token: string;
  journalPath: string;
}

export class ConfigError extends Error {}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

export function loadAdapterConfig(file: string, env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  // `npm run adapter` runs inside packages/adapter; a relative --config means where the user typed it.
  file = path.resolve(env.INIT_CWD ?? process.cwd(), file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`Cannot read config ${file}: ${(err as Error).message}`);
  }
  const parsed = FileConfig.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const c = parsed.data;
  const base = path.dirname(file);
  const url = new URL(c.serverUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new ConfigError("serverUrl must use https:// (plain http is only allowed for localhost)");
  }
  let token = env.RELAYROOM_AGENT_TOKEN?.trim() ?? "";
  if (!token && c.tokenFile) {
    try {
      token = readFileSync(path.resolve(base, c.tokenFile), "utf8").trim();
    } catch {
      throw new ConfigError("tokenFile could not be read");
    }
  }
  if (!token.startsWith("rr_agent_")) throw new ConfigError("Set RELAYROOM_AGENT_TOKEN (or tokenFile) to the agent token from RelayRoom");
  const projectDir = validateProjectDir(path.resolve(base, c.projectDir));
  const stateDir = c.stateDir ? path.resolve(base, c.stateDir) : path.join(homedir(), ".relayroom");
  const id = createHash("sha256").update(token).digest("hex").slice(0, 16);
  return {
    serverUrl: url.toString().replace(/\/$/, ""),
    projectDir,
    provider: c.provider,
    ...(c.providerBin ? { providerBin: path.resolve(base, c.providerBin) } : {}),
    maxPermission: c.maxPermission,
    ...(c.allowedRequesters ? { allowedRequesters: c.allowedRequesters.map((u) => u.toLowerCase()) } : {}),
    ...(c.allowedCommands ? { allowedCommands: c.allowedCommands } : {}),
    timeoutMs: c.timeoutMinutes * 60_000,
    approvals: c.approvals,
    approvalTimeoutMs: c.approvalTimeoutMinutes * 60_000,
    worktrees: c.worktrees,
    token,
    journalPath: path.join(stateDir, `adapter-${id}.json`),
  };
}
