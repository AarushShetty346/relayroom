import type { ObservedCommand } from "@relayroom/protocol";
import type { DetectResult, DriverEvent, ProviderDriver, RunOptions, RunResult } from "./types.js";
import { runVersion, spawnCli, truncate, which } from "../proc.js";
import { APPROVAL_TOOL_ID } from "../approval-policy.js";
import { startApprovalBridge, type ApprovalBridge } from "../approval-bridge.js";

/**
 * Claude Code via its documented headless mode:
 *   claude -p --output-format stream-json --verbose
 * The prompt is written to stdin. Permissions are enforced by Claude Code itself:
 *   read-only → only the Read/Grep/Glob tools exist for the session
 *   edit      → acceptEdits mode (file edits inside the working directory) plus an explicit
 *               allowlist of shell commands; anything else that would need approval is denied
 *               automatically (--permission-prompts none) and reported back as a denial.
 *   edit + approvals → the same, but permission prompts go to the adapter's MCP tool
 *               (--permission-prompt-tool, a hidden flag of the installed CLI) instead of being
 *               denied: the adapter applies its local cap and asks a human in the room.
 * Never passes --dangerously-skip-permissions or bypassPermissions.
 */

/** Shell commands that are never allowed, even if the user's own settings allow them. */
const ALWAYS_DENIED = [
  "Bash(git push:*)",
  "Bash(git reset --hard:*)",
  "Bash(git rebase:*)",
  "Bash(git clean:*)",
  "Bash(git checkout --:*)",
  "Bash(git restore:*)",
  "Bash(git merge:*)",
  "Bash(git branch -D:*)",
  "Bash(git filter-branch:*)",
  "Bash(rm -rf:*)",
  "Bash(npm publish:*)",
];

export const DEFAULT_CLAUDE_ALLOWED_COMMANDS = ["Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)"];

export function claudeArgs(
  permission: "read-only" | "edit",
  allowedCommands: string[],
  approval: { mcpConfigPath: string } | null = null,
): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence"];
  // Prompts reach a human only in edit runs; a read-only run's tool set is fixed.
  if (approval && permission === "edit") {
    args.push("--permission-prompts", "host", "--mcp-config", approval.mcpConfigPath, "--permission-prompt-tool", APPROVAL_TOOL_ID);
  } else {
    args.push("--permission-prompts", "none");
  }
  if (permission === "read-only") {
    args.push("--permission-mode", "default", "--tools", "Read,Grep,Glob");
  } else {
    args.push("--permission-mode", "acceptEdits");
    if (allowedCommands.length) args.push("--allowedTools", allowedCommands.join(","));
  }
  args.push("--disallowedTools", ALWAYS_DENIED.join(","));
  return args;
}

type Json = Record<string, any>;

/** Turns stream-json lines into generic events and a result. Pure; unit-tested with fixtures. */
export class ClaudeStreamParser {
  sessionId: string | null = null;
  finalText = "";
  isError = false;
  resultSubtype: string | null = null;
  commands: ObservedCommand[] = [];
  permissionDenials: string[] = [];
  sawResult = false;
  terminalReason: string | null = null;
  private assistantText: string[] = [];
  private pending = new Map<string, { name: string; command?: string }>();

  constructor(private displayPath: (p: string) => string = (p) => p) {}

  feed(line: string): DriverEvent[] {
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }
    const out: DriverEvent[] = [];
    if (msg.session_id && !this.sessionId) this.sessionId = String(msg.session_id);
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") out.push({ type: "status", text: `Claude Code session started${msg.model ? ` (${msg.model})` : ""}` });
        break;
      case "assistant": {
        for (const block of (msg.message?.content ?? []) as Json[]) {
          if (block.type === "text" && block.text) {
            this.assistantText.push(String(block.text));
            out.push({ type: "text", text: truncate(String(block.text), 4000) });
          } else if (block.type === "tool_use") {
            const name = String(block.name ?? "tool");
            const input = (block.input ?? {}) as Json;
            if (name === "Bash" && typeof input.command === "string") {
              this.pending.set(block.id, { name, command: input.command });
              out.push({ type: "command", text: `$ ${truncate(input.command, 1000)}` });
            } else if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) {
              this.pending.set(block.id, { name });
              const p = input.file_path ?? input.notebook_path;
              out.push({ type: "file_change", text: `${name} ${p ? this.displayPath(String(p)) : ""}`.trim() });
            } else {
              this.pending.set(block.id, { name });
              const target = input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query;
              out.push({ type: "tool", text: `${name}${target ? ` ${typeof target === "string" && /[\\/]/.test(target) ? this.displayPath(target) : truncate(String(target), 200)}` : ""}` });
            }
          }
        }
        break;
      }
      case "user": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content as Json[]) {
          if (block.type !== "tool_result") continue;
          const p = this.pending.get(block.tool_use_id);
          if (!p) continue;
          this.pending.delete(block.tool_use_id);
          if (p.command !== undefined) {
            // Claude Code reports error/success for tool results, not the numeric exit code.
            this.commands.push({ command: truncate(p.command, 2000), exitCode: null, ok: !block.is_error, source: "claude-code:Bash" });
          }
          if (block.is_error) {
            const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
            out.push({ type: "error", text: `${p.name} failed: ${truncate(text, 500)}` });
          }
        }
        break;
      }
      case "result": {
        this.sawResult = true;
        this.resultSubtype = msg.subtype ?? null;
        this.isError = Boolean(msg.is_error) || (typeof msg.subtype === "string" && msg.subtype !== "success");
        this.terminalReason = typeof msg.terminal_reason === "string" ? msg.terminal_reason : null;
        if (typeof msg.result === "string") this.finalText = msg.result;
        for (const d of (msg.permission_denials ?? []) as Json[]) {
          const input = d.tool_input ?? {};
          const detail = input.command ?? input.file_path ?? "";
          this.permissionDenials.push(truncate(`${d.tool_name}${detail ? `: ${detail}` : ""}`, 300));
        }
        break;
      }
    }
    return out;
  }

  /** Final reply: the result text, or the concatenated assistant text if no result arrived. */
  reply(): string {
    // On error the result field carries the error text (e.g. "Not logged in"), not a reply.
    if (this.isError) return "";
    return this.finalText || this.assistantText.join("\n\n");
  }

  errorText(): string {
    const parts = [
      this.finalText.trim(),
      this.resultSubtype && this.resultSubtype !== "success" ? this.resultSubtype : "",
      this.terminalReason ? `(${this.terminalReason})` : "",
    ];
    return `Claude Code error: ${parts.filter(Boolean).join(" ") || "unknown"}`;
  }
}

export function createClaudeDriver(opts: { bin?: string; allowedCommands?: string[]; displayPath?: (p: string) => string } = {}): ProviderDriver {
  let resolvedBin: string | null = null;
  return {
    id: "claude-code",
    label: "Claude Code",
    capabilities: { progressEvents: true, cancel: true, edit: true, approvals: true },
    async detect(): Promise<DetectResult | null> {
      resolvedBin = which(opts.bin ?? "claude");
      if (!resolvedBin) return null;
      return { bin: resolvedBin, version: await runVersion(resolvedBin, ["--version"]) };
    },
    async run(o: RunOptions): Promise<RunResult> {
      const bin = resolvedBin ?? which(opts.bin ?? "claude");
      if (!bin) {
        return failed("Claude Code CLI not found. Install it or set providerBin in the adapter config.");
      }
      const parser = new ClaudeStreamParser(opts.displayPath);
      let bridge: ApprovalBridge | null = null;
      let env = o.env;
      if (o.approvals && o.permission === "edit") {
        bridge = await startApprovalBridge(o.approvals.request);
        // Claude Code's MCP tool-call timeout must not cut a human decision short.
        env = { ...o.env, MCP_TOOL_TIMEOUT: String(o.approvals.timeoutMs + 60_000) };
      }
      const proc = spawnCli(
        bin,
        claudeArgs(o.permission, opts.allowedCommands ?? DEFAULT_CLAUDE_ALLOWED_COMMANDS, bridge ? { mcpConfigPath: bridge.configPath } : null),
        { cwd: o.cwd, env, stdin: o.prompt },
      );
      let cancelled = false;
      let timedOut = false;
      const onAbort = () => {
        cancelled = true;
        proc.kill();
      };
      o.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, o.timeoutMs);
      try {
        for await (const line of proc.lines) {
          if (!line.trim()) continue;
          for (const ev of parser.feed(line)) o.onEvent(ev);
        }
        const { code } = await proc.exited;
        const reply = parser.reply();
        const base = {
          exitCode: code,
          executionId: parser.sessionId,
          finalText: reply,
          commands: parser.commands,
          permissionDenials: parser.permissionDenials,
        };
        if (cancelled) return { ...base, outcome: "cancelled", errorMessage: "Cancelled by request" };
        if (timedOut) return { ...base, outcome: "failed", errorMessage: `Timed out after ${Math.round(o.timeoutMs / 1000)}s` };
        if (code === 0 && parser.sawResult && !parser.isError) return { ...base, outcome: "succeeded", errorMessage: null };
        const err = parser.isError
          ? parser.errorText()
          : !parser.sawResult
              ? `Claude Code exited with code ${code ?? "unknown"} without a result. ${truncate(proc.stderr().trim(), 800)}`
              : `Claude Code exited with code ${code}`;
        return { ...base, outcome: "failed", errorMessage: err.trim() };
      } finally {
        clearTimeout(timer);
        o.signal.removeEventListener("abort", onAbort);
        await bridge?.close();
      }
    },
  };
}

function failed(msg: string): RunResult {
  return { outcome: "failed", exitCode: null, executionId: null, finalText: "", errorMessage: msg, commands: [], permissionDenials: [] };
}
