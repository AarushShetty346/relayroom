import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVAL_MCP_SERVER } from "./approval-policy.js";
import type { ToolPermissionDecision, ToolPermissionRequest } from "./drivers/types.js";

export const APPROVAL_MCP_SCRIPT = fileURLToPath(new URL("../mcp/approval-server.mjs", import.meta.url));

export interface ApprovalBridge {
  /** Path of the generated `--mcp-config` file (holds the per-run secret; removed on close). */
  configPath: string;
  url: string;
  close(): Promise<void>;
}

/** Claude Code's permission prompt tool result. `updatedInput` is always the original input. */
export type PromptToolResult = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };

/**
 * Per-run loopback endpoint between the approval MCP server (a child of Claude Code) and this
 * adapter process. Listens on 127.0.0.1 only, on a random port, and requires a random bearer secret
 * that is only written to a private temp file passed to Claude Code as its MCP config.
 */
export async function startApprovalBridge(
  ask: (req: ToolPermissionRequest) => Promise<ToolPermissionDecision>,
  opts: { node?: string; script?: string } = {},
): Promise<ApprovalBridge> {
  const secret = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${secret}`);
  const server = http.createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const auth = Buffer.from(String(req.headers.authorization ?? ""));
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return reply(401, { error: "unauthorized" });
    if (req.method !== "POST" || req.url !== "/approval") return reply(404, { error: "not found" });
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      let body: { tool_name?: unknown; input?: unknown; tool_use_id?: unknown };
      try {
        body = JSON.parse(raw);
      } catch {
        return reply(400, { error: "bad json" });
      }
      const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? (body.input as Record<string, unknown>) : {};
      const request: ToolPermissionRequest = {
        toolName: typeof body.tool_name === "string" ? body.tool_name : "",
        input,
        toolUseId: typeof body.tool_use_id === "string" ? body.tool_use_id : null,
      };
      ask(request).then(
        (d) => reply(200, toPromptResult(d, input)),
        (err: Error) => reply(200, { behavior: "deny", message: `RelayRoom adapter error; denied (${err.message})` }),
      );
    });
  });
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(path.join(tmpdir(), "relayroom-approval-"));
  const configPath = path.join(dir, "mcp.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        [APPROVAL_MCP_SERVER]: {
          type: "stdio",
          command: opts.node ?? process.execPath,
          args: [opts.script ?? APPROVAL_MCP_SCRIPT],
          env: { RELAYROOM_APPROVAL_URL: url, RELAYROOM_APPROVAL_SECRET: secret },
        },
      },
    }),
    { mode: 0o600 },
  );
  return {
    configPath,
    url,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Only the original input is ever passed back: an approval cannot change what the agent runs. */
export function toPromptResult(d: ToolPermissionDecision, originalInput: Record<string, unknown>): PromptToolResult {
  return d.allow ? { behavior: "allow", updatedInput: originalInput } : { behavior: "deny", message: d.message };
}
