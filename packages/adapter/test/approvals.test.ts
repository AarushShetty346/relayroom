/**
 * Adapter side of human-in-the-loop approvals: the local cap, the Claude Code flags, and the MCP
 * permission-prompt server talking to the adapter's loopback bridge.
 *
 * The MCP test is a SIMULATION of Claude Code's side: the test speaks MCP (JSON-RPC over stdio) to the
 * real approval server process the way Claude Code would. It does not prove Claude Code calls the
 * tool; that was not observable here because the installed CLI is not logged in (PROGRESS.md).
 */
import { removeTemp } from "./tmp.js";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import {
  APPROVAL_TOOL_ID,
  approvalPolicy,
  claudeArgs,
  hardDeniedCommand,
  startApprovalBridge,
  summarizeToolUse,
  toPromptResult,
  type ToolPermissionRequest,
} from "../src/index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) removeTemp(d);
});
function tmp(): string {
  const d = realpathSync.native(mkdtempSync(path.join(tmpdir(), "rr-ap-")));
  dirs.push(d);
  return d;
}

describe("local approval cap", () => {
  const cwd = tmp();

  it("read-only runs can never be widened by an approval", () => {
    for (const toolName of ["Bash", "Write", "Read", "WebFetch"]) {
      const r = approvalPolicy({ permission: "read-only", cwd, toolName, input: { command: "ls", file_path: "a.txt" } });
      expect(r.ask).toBe(false);
    }
  });

  it("edit runs: ordinary shell commands and other tools go to a human", () => {
    expect(approvalPolicy({ permission: "edit", cwd, toolName: "Bash", input: { command: "npm install left-pad" } })).toEqual({ ask: true });
    expect(approvalPolicy({ permission: "edit", cwd, toolName: "WebFetch", input: { url: "https://example.invalid" } })).toEqual({ ask: true });
    expect(approvalPolicy({ permission: "edit", cwd, toolName: "Write", input: { file_path: path.join(cwd, "src", "new.ts") } })).toEqual({ ask: true });
    expect(approvalPolicy({ permission: "edit", cwd, toolName: "Edit", input: { file_path: "relative/inside.ts" } })).toEqual({ ask: true });
  });

  it("always-denied commands are refused locally, also inside compound commands", () => {
    for (const cmd of [
      "git push",
      "git push origin main --force",
      "npm test && git push",
      "git -C ../other push",
      "cd x; git reset --hard HEAD~1",
      "git rebase -i main",
      "git clean -fdx",
      "git checkout -- .",
      "git branch -D feature",
      "rm -rf /",
      "rm -r -f build",
      "rm -fr build",
      "npm publish",
      "Remove-Item -Recurse -Force C:\\x",
    ]) {
      expect(hardDeniedCommand(cmd), cmd).not.toBeNull();
      expect(approvalPolicy({ permission: "edit", cwd, toolName: "Bash", input: { command: cmd } }).ask, cmd).toBe(false);
    }
    for (const cmd of ["git status", "git diff HEAD", "npm test", "rm build/out.txt", "rm -r build", "echo push"]) {
      expect(hardDeniedCommand(cmd), cmd).toBeNull();
    }
  });

  it("file tools outside the run directory are refused, including via symlinks", () => {
    const outside = tmp();
    const r1 = approvalPolicy({ permission: "edit", cwd, toolName: "Write", input: { file_path: path.join(outside, "x.txt") } });
    expect(r1).toMatchObject({ ask: false });
    const r2 = approvalPolicy({ permission: "edit", cwd, toolName: "Edit", input: { file_path: "../escape.txt" } });
    expect(r2).toMatchObject({ ask: false });
    const r3 = approvalPolicy({ permission: "edit", cwd, toolName: "Glob", input: { pattern: path.join(outside, "**") } });
    expect(r3).toMatchObject({ ask: false });
    let linked = false;
    try {
      mkdirSync(path.join(cwd, "sub"), { recursive: true });
      symlinkSync(outside, path.join(cwd, "sub", "link"), "junction");
      linked = true;
    } catch {
      // Symlinks may be unavailable (Windows without privileges); covered by the cases above.
    }
    if (linked) {
      expect(approvalPolicy({ permission: "edit", cwd, toolName: "Write", input: { file_path: path.join(cwd, "sub", "link", "x.txt") } })).toMatchObject({ ask: false });
    }
  });

  it("the approval tool cannot approve itself", () => {
    expect(approvalPolicy({ permission: "edit", cwd, toolName: APPROVAL_TOOL_ID, input: {} }).ask).toBe(false);
  });

  it("summaries are short and use project-relative paths", () => {
    expect(summarizeToolUse("Bash", { command: "npm i" })).toBe("$ npm i");
    expect(summarizeToolUse("Write", { file_path: path.join(cwd, "a", "b.ts") }, (p) => path.relative(cwd, p).split(path.sep).join("/"))).toBe("Write a/b.ts");
    expect(summarizeToolUse("WebSearch", { query: "left-pad" })).toBe("WebSearch left-pad");
    expect(summarizeToolUse("mcp__x__y", {})).toBe("mcp__x__y");
  });

  it("an approval passes back the original input only", () => {
    const input = { command: "npm i" };
    expect(toPromptResult({ allow: true }, input)).toEqual({ behavior: "allow", updatedInput: input });
    expect(toPromptResult({ allow: false, message: "no" }, input)).toEqual({ behavior: "deny", message: "no" });
  });
});

describe("Claude Code flags", () => {
  it("without approvals: prompts are denied automatically (unchanged behaviour)", () => {
    const a = claudeArgs("edit", ["Bash(npm test:*)"]);
    expect(a.join(" ")).toContain("--permission-prompts none");
    expect(a).not.toContain("--permission-prompt-tool");
  });

  it("with approvals in edit runs: prompts go to the adapter's MCP tool", () => {
    const a = claudeArgs("edit", ["Bash(npm test:*)"], { mcpConfigPath: "/tmp/mcp.json" });
    expect(a.join(" ")).toContain(`--permission-prompts host --mcp-config /tmp/mcp.json --permission-prompt-tool ${APPROVAL_TOOL_ID}`);
    expect(a).not.toContain("none");
    // The always-denied rules stay in place and are never offered to a human.
    expect(a[a.indexOf("--disallowedTools") + 1]).toContain("Bash(git push:*)");
    expect(a).not.toContain("--dangerously-skip-permissions");
    expect(a).not.toContain("bypassPermissions");
  });

  it("read-only runs never get the prompt tool", () => {
    const a = claudeArgs("read-only", [], { mcpConfigPath: "/tmp/mcp.json" });
    expect(a.join(" ")).toContain("--permission-prompts none");
    expect(a).not.toContain("--mcp-config");
  });
});

/** Minimal MCP client over stdio, standing in for Claude Code. */
function mcpClient(command: string, args: string[], env: Record<string, string>) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (m: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (line) => {
    const m = JSON.parse(line);
    waiting.get(m.id)?.(m);
  });
  let id = 0;
  return {
    call(method: string, params: unknown = {}) {
      const myId = ++id;
      return new Promise<any>((resolve) => {
        waiting.set(myId, resolve);
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
      });
    },
    notify(method: string) {
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
    },
    close() {
      child.stdin!.end();
      child.kill();
    },
  };
}

describe("approval MCP server ↔ adapter bridge (simulated Claude Code side)", () => {
  it("answers initialize/tools/list and forwards tools/call to the adapter, returning Claude Code's result format", async () => {
    const seen: ToolPermissionRequest[] = [];
    const bridge = await startApprovalBridge(async (req) => {
      seen.push(req);
      return req.toolName === "Bash" ? { allow: true } : { allow: false, message: "denied by a human" };
    });
    try {
      const cfg = JSON.parse(readFileSync(bridge.configPath, "utf8"));
      const server = cfg.mcpServers.relayroom_approvals;
      expect(server.type).toBe("stdio");
      expect(server.env.RELAYROOM_APPROVAL_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const mcp = mcpClient(server.command, server.args, server.env);
      const init = await mcp.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
      mcp.notify("notifications/initialized");
      const list = await mcp.call("tools/list");
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["approval_prompt"]);

      const input = { command: "npm install left-pad", description: "install" };
      const allow = await mcp.call("tools/call", { name: "approval_prompt", arguments: { tool_name: "Bash", input, tool_use_id: "toolu_1" } });
      expect(allow.result.content).toHaveLength(1);
      expect(allow.result.content[0].type).toBe("text");
      expect(JSON.parse(allow.result.content[0].text)).toEqual({ behavior: "allow", updatedInput: input });
      expect(seen[0]).toEqual({ toolName: "Bash", input, toolUseId: "toolu_1" });

      const deny = await mcp.call("tools/call", { name: "approval_prompt", arguments: { tool_name: "WebFetch", input: { url: "https://x.invalid" } } });
      expect(JSON.parse(deny.result.content[0].text)).toEqual({ behavior: "deny", message: "denied by a human" });

      expect((await mcp.call("resources/list")).error.code).toBe(-32601);
      mcp.close();

      // Without the per-run secret the bridge refuses, and the server turns that into a denial.
      const wrong = mcpClient(server.command, server.args, { ...server.env, RELAYROOM_APPROVAL_SECRET: "wrong" });
      await wrong.call("initialize", {});
      const r = await wrong.call("tools/call", { name: "approval_prompt", arguments: { tool_name: "Bash", input: { command: "id" } } });
      expect(JSON.parse(r.result.content[0].text)).toMatchObject({ behavior: "deny" });
      expect(seen).toHaveLength(2);
      wrong.close();
    } finally {
      await bridge.close();
    }
    // The config file holding the secret is removed with the bridge.
    expect(() => readFileSync(bridge.configPath)).toThrow();
  });
});
