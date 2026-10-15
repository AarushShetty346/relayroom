import { realpathSync } from "node:fs";
import path from "node:path";
import type { PermissionProfile } from "@relayroom/protocol";
import { isWithin } from "./paths.js";
import { truncate } from "./proc.js";

/**
 * The adapter's local cap on what a human in the room may approve. It runs before anything is sent
 * to the server: a request that fails here is denied on this machine and never shown as approvable.
 * A remote approval can therefore only unlock actions this adapter's owner already allows in principle.
 */

/** MCP server name the adapter registers with Claude Code for its permission prompt tool. */
export const APPROVAL_MCP_SERVER = "relayroom_approvals";
export const APPROVAL_MCP_TOOL = "approval_prompt";
export const APPROVAL_TOOL_ID = `mcp__${APPROVAL_MCP_SERVER}__${APPROVAL_MCP_TOOL}`;

const PATH_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead", "Grep", "Glob", "LS"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

type Input = Record<string, unknown>;

export type PolicyResult = { ask: true } | { ask: false; reason: string };

/**
 * Shell commands that are never approvable, mirroring the driver's always-denied rules. This is a
 * backstop: Claude Code's own deny rules normally stop these before a prompt is raised. It matches
 * per command segment and errs on the side of denying.
 */
export function hardDeniedCommand(command: string): string | null {
  for (const segment of command.split(/&&|\|\||[;&|\n]/)) {
    const t = segment.trim().split(/\s+/).map((x) => x.replace(/^["']|["']$/g, ""));
    const has = (w: string) => t.includes(w);
    const lower = t.map((x) => x.toLowerCase());
    if (has("git") || t.some((x) => /(^|[\\/])git(\.exe)?$/i.test(x))) {
      for (const sub of ["push", "rebase", "clean", "restore", "merge", "filter-branch"]) if (has(sub)) return `git ${sub}`;
      if (has("reset") && has("--hard")) return "git reset --hard";
      if (has("branch") && (has("-D") || (has("--delete") && has("--force")))) return "git branch -D";
      if (has("checkout") && has("--")) return "git checkout --";
    }
    const recursive = t.some((x) => /^-[a-zA-Z]*[rR]/.test(x) || x === "--recursive");
    const force = t.some((x) => /^-[a-zA-Z]*f/.test(x) || x === "--force");
    if (has("rm") && recursive && force) return "rm -rf";
    if (has("npm") && has("publish")) return "npm publish";
    if (lower.includes("remove-item") && lower.includes("-recurse") && lower.includes("-force")) return "Remove-Item -Recurse -Force";
  }
  return null;
}

/** True if `p` (absolute or relative to root) stays inside root, also after resolving symlinks. */
export function staysInside(root: string, p: string): boolean {
  if (p.includes("\0")) return false;
  let realRoot = root;
  try {
    realRoot = realpathSync.native(root);
  } catch {
    // keep as given
  }
  const abs = path.resolve(realRoot, p);
  if (!isWithin(realRoot, abs)) return false;
  let probe = abs;
  for (;;) {
    try {
      return isWithin(realRoot, realpathSync.native(probe));
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

/**
 * Decides whether a tool use may be put to a human at all.
 * - read-only runs: never. Their tool set is fixed; there is nothing a human may add.
 * - edit runs: file tools only inside the run's directory; never the hard-denied shell commands;
 *   other tools (shell, web, MCP) go to a human.
 */
export function approvalPolicy(opts: { permission: PermissionProfile; cwd: string; toolName: string; input: Input }): PolicyResult {
  const { permission, cwd, toolName, input } = opts;
  if (permission !== "edit") return { ask: false, reason: "this is a read-only run; nothing beyond its read-only tools can be approved" };
  if (toolName.startsWith(`mcp__${APPROVAL_MCP_SERVER}__`)) return { ask: false, reason: "the approval tool cannot be approved through itself" };
  if (SHELL_TOOLS.has(toolName)) {
    const cmd = typeof input.command === "string" ? input.command : "";
    const bad = hardDeniedCommand(cmd);
    if (bad) return { ask: false, reason: `\`${bad}\` is never allowed on this adapter` };
    return { ask: true };
  }
  if (PATH_TOOLS.has(toolName)) {
    const paths = [input.file_path, input.notebook_path, input.path].filter((x): x is string => typeof x === "string" && x.length > 0);
    if (toolName === "Glob" && typeof input.pattern === "string" && path.isAbsolute(input.pattern)) paths.push(input.pattern);
    for (const p of paths) {
      if (!staysInside(cwd, p)) return { ask: false, reason: "the path is outside the adapter's registered directory" };
    }
    return { ask: true };
  }
  return { ask: true };
}

/** One line a human can judge quickly. */
export function summarizeToolUse(toolName: string, input: Input, displayPath: (p: string) => string = (p) => p): string {
  if (SHELL_TOOLS.has(toolName) && typeof input.command === "string") return `$ ${truncate(input.command, 1500)}`;
  const p = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof p === "string") return `${toolName} ${displayPath(p)}`;
  const target = input.url ?? input.query ?? input.pattern;
  if (typeof target === "string") return `${toolName} ${truncate(target, 500)}`;
  const json = JSON.stringify(input) ?? "";
  return json && json !== "{}" ? `${toolName} ${truncate(json, 500)}` : toolName;
}
