import type { ObservedCommand } from "@relayroom/protocol";
import type { DetectResult, DriverEvent, ProviderDriver, RunOptions, RunResult } from "./types.js";
import { captureLine, runCapture, runVersion, spawnCli, truncate, which } from "../proc.js";

/**
 * OpenAI Codex via its documented non-interactive mode:
 *   codex exec --json -C <dir> -s <sandbox> -c approval_policy=never --ephemeral -
 * The prompt is read from stdin ("-"). Codex enforces the sandbox itself:
 *   read-only → `-s read-only`; edit → `-s workspace-write` (writes confined to the directory).
 * approval_policy=never means nothing escalates silently: commands the sandbox blocks fail and are
 * reported back. Never passes --dangerously-bypass-approvals-and-sandbox.
 */
export function codexArgs(cwd: string, permission: "read-only" | "edit"): string[] {
  return [
    "exec",
    "--json",
    "--color",
    "never",
    "--ephemeral",
    "-C",
    cwd,
    "-s",
    permission === "edit" ? "workspace-write" : "read-only",
    "-c",
    "approval_policy=never",
    "-",
  ];
}

type Json = Record<string, any>;

/** Parses `codex exec --json` JSONL events. Pure; unit-tested with fixtures. */
export class CodexStreamParser {
  threadId: string | null = null;
  lastAgentMessage = "";
  /** Set by turn.failed: the run did not complete. */
  failed: string | null = null;
  /** Last `error` event. Codex also emits these for transient retries ("Reconnecting... 2/5"). */
  lastError: string | null = null;
  turnCompleted = false;
  commands: ObservedCommand[] = [];

  constructor(private displayPath: (p: string) => string = (p) => p) {}

  feed(line: string): DriverEvent[] {
    let ev: Json;
    try {
      ev = JSON.parse(line);
    } catch {
      return [];
    }
    const out: DriverEvent[] = [];
    switch (ev.type) {
      case "thread.started":
        this.threadId = ev.thread_id ? String(ev.thread_id) : null;
        out.push({ type: "status", text: "Codex session started" });
        break;
      case "turn.completed":
        this.turnCompleted = true;
        break;
      case "turn.failed":
        this.failed = String(ev.error?.message ?? "turn failed");
        out.push({ type: "error", text: truncate(this.failed, 1000) });
        break;
      case "error":
        this.lastError = String(ev.message ?? "error");
        out.push({ type: "error", text: truncate(this.lastError, 1000) });
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = (ev.item ?? {}) as Json;
        const done = ev.type === "item.completed";
        switch (item.type) {
          case "agent_message":
            if (done && typeof item.text === "string") {
              this.lastAgentMessage = item.text;
              out.push({ type: "text", text: truncate(item.text, 4000) });
            }
            break;
          case "command_execution":
            if (ev.type === "item.started") out.push({ type: "command", text: `$ ${truncate(String(item.command ?? ""), 1000)}` });
            if (done) {
              const exit = typeof item.exit_code === "number" ? item.exit_code : null;
              this.commands.push({
                command: truncate(String(item.command ?? ""), 2000),
                exitCode: exit,
                ok: exit === null ? (item.status === "completed" ? true : item.status === "failed" ? false : null) : exit === 0,
                source: "codex:command_execution",
              });
              if (exit !== null && exit !== 0) out.push({ type: "error", text: `Command exited with ${exit}` });
            }
            break;
          case "file_change":
            if (done)
              for (const c of (item.changes ?? []) as Json[])
                out.push({ type: "file_change", text: `${c.kind ?? "update"} ${this.displayPath(String(c.path ?? ""))}` });
            break;
          case "mcp_tool_call":
            if (ev.type === "item.started") out.push({ type: "tool", text: `${item.server ?? "mcp"}.${item.tool ?? "tool"}` });
            break;
          case "web_search":
            if (ev.type === "item.started") out.push({ type: "tool", text: `web search: ${truncate(String(item.query ?? ""), 200)}` });
            break;
          case "error":
            out.push({ type: "error", text: truncate(String(item.message ?? "error"), 1000) });
            break;
        }
        break;
      }
    }
    return out;
  }
}

/**
 * Reads the sandbox mode Codex will really apply, from `codex debug prompt-input` (renders the
 * model-visible prompt without calling a model). Best effort: returns null if the text is not found.
 */
export function parseEffectiveSandbox(promptInput: string | null): "read-only" | "workspace-write" | "danger-full-access" | null {
  const m = promptInput ? /`sandbox_mode` is `([a-z-]+)`/.exec(promptInput) : null;
  const mode = m?.[1];
  return mode === "read-only" || mode === "workspace-write" || mode === "danger-full-access" ? mode : null;
}

export function createCodexDriver(opts: { bin?: string; displayPath?: (p: string) => string; probeDir?: string } = {}): ProviderDriver {
  let resolvedBin: string | null = null;
  return {
    id: "codex",
    label: "Codex",
    // Approvals: not supported. `codex exec` has no prompt channel (approval_policy=never). The
    // app-server protocol does have approval requests, but that integration is not built/verified.
    capabilities: { progressEvents: true, cancel: true, edit: true, approvals: false },
    async detect(): Promise<DetectResult | null> {
      resolvedBin = which(opts.bin ?? "codex");
      if (!resolvedBin) return null;
      const version = await runVersion(resolvedBin, ["--version"]);
      const sandbox = parseEffectiveSandbox(
        await runCapture(resolvedBin, ["debug", "prompt-input", "-c", "sandbox_mode=workspace-write", "-c", "approval_policy=never", "probe"], {
          ...(opts.probeDir ? { cwd: opts.probeDir } : {}),
        }),
      );
      if (sandbox === "read-only") {
        return {
          bin: resolvedBin,
          version,
          canEdit: false,
          editNote: "Codex downgrades the workspace-write sandbox to read-only on this machine (its own sandbox for this OS is not available)",
        };
      }
      return { bin: resolvedBin, version, canEdit: sandbox === "workspace-write" ? true : null };
    },
    async run(o: RunOptions): Promise<RunResult> {
      const bin = resolvedBin ?? which(opts.bin ?? "codex");
      if (!bin) {
        return {
          outcome: "failed",
          exitCode: null,
          executionId: null,
          finalText: "",
          errorMessage: "Codex CLI not found. Install it or set providerBin in the adapter config.",
          commands: [],
          permissionDenials: [],
        };
      }
      const parser = new CodexStreamParser(opts.displayPath);
      const proc = spawnCli(bin, codexArgs(o.cwd, o.permission), { cwd: o.cwd, env: o.env, stdin: o.prompt });
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
          captureLine(line);
          for (const ev of parser.feed(line)) o.onEvent(ev);
        }
        const { code } = await proc.exited;
        const base = {
          exitCode: code,
          executionId: parser.threadId,
          finalText: parser.lastAgentMessage,
          commands: parser.commands,
          permissionDenials: [],
        };
        if (cancelled) return { ...base, outcome: "cancelled", errorMessage: "Cancelled by request" };
        if (timedOut) return { ...base, outcome: "failed", errorMessage: `Timed out after ${Math.round(o.timeoutMs / 1000)}s` };
        if (code === 0 && parser.turnCompleted && !parser.failed) return { ...base, outcome: "succeeded", errorMessage: null };
        const err = parser.failed ?? parser.lastError ?? `Codex exited with code ${code ?? "unknown"}. ${truncate(proc.stderr().trim(), 800)}`;
        return { ...base, outcome: "failed", errorMessage: err.trim() };
      } finally {
        clearTimeout(timer);
        o.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
