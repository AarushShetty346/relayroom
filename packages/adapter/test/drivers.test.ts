import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ClaudeStreamParser, claudeArgs, createClaudeDriver, mirrorShellRules } from "../src/drivers/claude-code.js";
import { CodexStreamParser, codexArgs, createCodexDriver, parseEffectiveSandbox } from "../src/drivers/codex.js";
import type { DriverEvent } from "../src/drivers/types.js";

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8").split("\n").filter(Boolean);

describe("Claude Code stream-json parser", () => {
  it("REAL capture (claude 2.1.295, not logged in): reports a failure, not a reply", () => {
    const p = new ClaudeStreamParser();
    const events = fixture("claude-not-logged-in.real.jsonl").flatMap((l) => p.feed(l));
    expect(p.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.sawResult).toBe(true);
    expect(p.isError).toBe(true);
    expect(p.reply()).toBe("");
    expect(p.errorText()).toMatch(/Not logged in/);
    expect(events[0]).toEqual({ type: "status", text: expect.stringContaining("session started") });
  });

  // Constructed from Claude Code's documented stream-json message shapes (system/assistant/user/result);
  // not a captured run, because no authenticated Claude Code was available in this environment.
  it("CONSTRUCTED: tool use, commands, file edits, denials and the final result", () => {
    const root = path.resolve("/work/proj");
    const p = new ClaudeStreamParser((f) => path.relative(root, f).split(path.sep).join("/"));
    const lines = [
      { type: "system", subtype: "init", session_id: "s-1", model: "m" },
      { type: "assistant", session_id: "s-1", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: path.join(root, "src", "auth.ts") } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "done" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "git push" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", is_error: true, content: "Permission denied" }] } },
      { type: "result", subtype: "success", is_error: false, result: "Fixed it.", session_id: "s-1", permission_denials: [{ tool_name: "Bash", tool_input: { command: "git push" } }] },
    ];
    const events: DriverEvent[] = lines.flatMap((l) => p.feed(JSON.stringify(l)));
    expect(events.map((e) => e.type)).toEqual(["status", "text", "command", "file_change", "command", "error"]);
    expect(events[3]!.text).toBe("Edit src/auth.ts");
    expect(p.commands).toEqual([
      { command: "npm test", exitCode: null, ok: true, source: "claude-code:Bash" },
      { command: "git push", exitCode: null, ok: false, source: "claude-code:Bash" },
    ]);
    expect(p.reply()).toBe("Fixed it.");
    expect(p.permissionDenials).toEqual(["Bash: git push"]);
  });

  it("ignores garbage lines", () => {
    const p = new ClaudeStreamParser();
    expect(p.feed("not json")).toEqual([]);
    expect(p.feed('{"type":"unknown"}')).toEqual([]);
  });

  it("maps permissions to Claude Code's own controls and never bypasses them", () => {
    const ro = claudeArgs("read-only", []);
    expect(ro).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--verbose", "--permission-prompts", "none", "--tools", "Read,Grep,Glob"]));
    const ed = claudeArgs("edit", ["Bash(npm test:*)"]);
    // On Windows Claude Code runs shell commands through PowerShell, so allow rules are mirrored.
    expect(ed).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits", "--allowedTools", "Bash(npm test:*),PowerShell(npm test:*)"]));
    for (const a of [ro, ed]) {
      expect(a.join(" ")).not.toMatch(/dangerously|bypassPermissions/);
      const denied = a[a.indexOf("--disallowedTools") + 1]!.split(",");
      for (const rule of ["git push:*", "git reset --hard:*", "rm -rf:*"]) {
        expect(denied).toContain(`Bash(${rule})`);
        expect(denied).toContain(`PowerShell(${rule})`);
      }
    }
  });

  it("mirrors shell allow rules across Bash and PowerShell, leaving other rules alone", () => {
    expect(mirrorShellRules(["Bash(git:*)", "PowerShell(npm test:*)", "WebFetch"]).sort()).toEqual(
      ["Bash(git:*)", "Bash(npm test:*)", "PowerShell(git:*)", "PowerShell(npm test:*)", "WebFetch"].sort(),
    );
  });

  // Captured from Claude Code 2.1.295 on Windows with every git command allowed and no RelayRoom prompt:
  // the push was refused by the always-deny rules, once through each shell tool.
  for (const [n, tool] of [
    [1, "Bash"],
    [2, "PowerShell"],
  ] as const) {
    it(`REAL capture: git push through ${tool} is recorded as a failed command and a permission denial`, () => {
      const p = new ClaudeStreamParser();
      const events = fixture(`claude-push-denied-${n}.real.jsonl`).flatMap((l) => p.feed(l));
      expect(p.isError).toBe(false);
      expect(p.commands).toEqual([{ command: "git push origin main", exitCode: null, ok: false, source: `claude-code:${tool}` }]);
      expect(p.permissionDenials).toEqual([`${tool}: git push origin main`]);
      expect(events.some((e) => e.type === "command" && e.text === "$ git push origin main")).toBe(true);
      expect(events.some((e) => e.type === "error" && e.text.includes("has been denied"))).toBe(true);
      expect(p.reply().length).toBeGreaterThan(0);
    });
  }
});

describe("Codex exec --json parser", () => {
  it("REAL capture (codex-cli 0.162.0-alpha, not logged in): transient errors then turn.failed", () => {
    const p = new CodexStreamParser();
    const events = fixture("codex-not-logged-in.real.jsonl").flatMap((l) => p.feed(l));
    expect(p.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.turnCompleted).toBe(false);
    expect(p.failed).toMatch(/401 Unauthorized/);
    expect(events.filter((e) => e.type === "error").length).toBeGreaterThan(3);
  });

  it("CONSTRUCTED: a transient reconnect error does not fail a turn that completes", () => {
    const p = new CodexStreamParser();
    const lines = [
      { type: "thread.started", thread_id: "th-1" },
      { type: "turn.started" },
      { type: "error", message: "Reconnecting... 1/5" },
      { type: "item.started", item: { id: "i1", type: "command_execution", command: "npm test", status: "in_progress" } },
      { type: "item.completed", item: { id: "i1", type: "command_execution", command: "npm test", exit_code: 1, status: "failed" } },
      { type: "item.completed", item: { id: "i2", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }], status: "completed" } },
      { type: "item.completed", item: { id: "i3", type: "agent_message", text: "Tests fail on main already." } },
      { type: "turn.completed", usage: {} },
    ];
    for (const l of lines) p.feed(JSON.stringify(l));
    expect(p.failed).toBeNull();
    expect(p.turnCompleted).toBe(true);
    expect(p.lastAgentMessage).toBe("Tests fail on main already.");
    expect(p.commands).toEqual([{ command: "npm test", exitCode: 1, ok: false, source: "codex:command_execution" }]);
  });

  it("maps permissions to Codex sandbox modes and never bypasses them", () => {
    expect(codexArgs("/p", "read-only")).toEqual(expect.arrayContaining(["exec", "--json", "-s", "read-only", "-c", "approval_policy=never", "-"]));
    expect(codexArgs("/p", "edit")).toEqual(expect.arrayContaining(["-s", "workspace-write"]));
    expect(codexArgs("/p", "edit").join(" ")).not.toMatch(/dangerously|danger-full-access/);
  });
});

/**
 * DRIVER PROCESS SIMULATION: a fake CLI (node script) stands in for the provider binary so the spawn,
 * stdin, streaming, cancellation and timeout paths are exercised. Not a provider integration test.
 */
describe("driver process handling (simulated CLI)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rr-fakecli-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function fakeCli(name: string, body: string): string {
    const js = path.join(dir, `${name}.mjs`);
    writeFileSync(js, body);
    if (process.platform === "win32") {
      const cmd = path.join(dir, `${name}.cmd`);
      writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
      return cmd;
    }
    const sh = path.join(dir, name);
    writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
    return sh;
  }

  const base = { cwd: dir, permission: "read-only" as const, timeoutMs: 20_000, env: process.env };

  it("streams events, reads the prompt from stdin and returns the result", async () => {
    const bin = fakeCli(
      "claude-ok",
      `let input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => {
        const out = (o) => console.log(JSON.stringify(o));
        out({ type: "system", subtype: "init", session_id: "sess-42", model: "fake" });
        out({ type: "assistant", message: { content: [{ type: "text", text: "echo:" + input.trim().split("\\n").pop() }] } });
        out({ type: "result", subtype: "success", is_error: false, result: "done:" + process.argv.includes("--tools"), session_id: "sess-42", permission_denials: [] });
      });`,
    );
    const driver = createClaudeDriver({ bin });
    const events: DriverEvent[] = [];
    const r = await driver.run({ ...base, prompt: "line1\nsay hi", signal: new AbortController().signal, onEvent: (e) => events.push(e) });
    expect(r).toMatchObject({ outcome: "succeeded", exitCode: 0, executionId: "sess-42", finalText: "done:true" });
    expect(events.find((e) => e.type === "text")!.text).toBe("echo:say hi");
  });

  it("cancels a running process", async () => {
    const bin = fakeCli("codex-slow", `console.log(JSON.stringify({ type: "thread.started", thread_id: "t" })); setInterval(() => {}, 1000);`);
    const driver = createCodexDriver({ bin });
    const ac = new AbortController();
    const p = driver.run({ ...base, prompt: "x", signal: ac.signal, onEvent: () => {} });
    setTimeout(() => ac.abort(), 1500);
    const r = await p;
    expect(r.outcome).toBe("cancelled");
    expect(r.executionId).toBe("t");
  });

  it("fails on timeout and on a non-zero exit without a result", async () => {
    const slow = fakeCli("claude-slow", `setInterval(() => {}, 1000);`);
    const r1 = await createClaudeDriver({ bin: slow }).run({ ...base, timeoutMs: 1000, prompt: "x", signal: new AbortController().signal, onEvent: () => {} });
    expect(r1.outcome).toBe("failed");
    expect(r1.errorMessage).toMatch(/Timed out/);
    const crash = fakeCli("claude-crash", `console.error("boom"); process.exit(3);`);
    const r2 = await createClaudeDriver({ bin: crash }).run({ ...base, prompt: "x", signal: new AbortController().signal, onEvent: () => {} });
    expect(r2).toMatchObject({ outcome: "failed", exitCode: 3 });
    expect(r2.errorMessage).toMatch(/boom/);
  });

  it("reports a missing CLI clearly", async () => {
    const r = await createCodexDriver({ bin: path.join(dir, "does-not-exist") }).run({ ...base, prompt: "x", signal: new AbortController().signal, onEvent: () => {} });
    expect(r.outcome).toBe("failed");
    expect(r.errorMessage).toMatch(/not found/);
  });

  it("detects when Codex downgrades workspace-write to read-only", async () => {
    // The permissions text matches what codex-cli 0.162.0-alpha renders on Windows (captured 2026-10-15).
    const fake = (name: string, mode: string) =>
      fakeCli(
        name,
        `const a = process.argv.slice(2);
        if (a[0] === "--version") console.log("codex-cli 0.0.0-fake");
        else if (a[0] === "debug" && a[1] === "prompt-input") console.log(JSON.stringify([{ text: "<permissions instructions>\\nFilesystem sandboxing defines which files can be read or written. \`sandbox_mode\` is \`${mode}\`: ..." }]));`,
      );
    const ro = await createCodexDriver({ bin: fake("codex-ro", "read-only") }).detect();
    expect(ro).toMatchObject({ version: "codex-cli 0.0.0-fake", canEdit: false });
    expect(ro?.editNote).toMatch(/read-only/);
    expect((await createCodexDriver({ bin: fake("codex-ww", "workspace-write") }).detect())?.canEdit).toBe(true);
  });
});

describe("Codex effective sandbox parsing", () => {
  it("reads the mode from prompt-input text and returns null when absent", () => {
    expect(parseEffectiveSandbox("... `sandbox_mode` is `read-only`: The sandbox only permits reading files.")).toBe("read-only");
    expect(parseEffectiveSandbox("`sandbox_mode` is `workspace-write`")).toBe("workspace-write");
    expect(parseEffectiveSandbox("nothing here")).toBeNull();
    expect(parseEffectiveSandbox(null)).toBeNull();
  });
});
