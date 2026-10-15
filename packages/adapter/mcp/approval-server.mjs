#!/usr/bin/env node
// RelayRoom approval prompt tool: a minimal MCP server (JSON-RPC 2.0 over stdio, newline-delimited)
// that Claude Code starts via --mcp-config and calls via --permission-prompt-tool whenever a tool use
// needs permission. Each call is forwarded to the adapter process that started Claude Code, over a
// loopback HTTP bridge guarded by a per-run secret. The adapter applies its local cap, asks the room
// and answers allow/deny. Plain JavaScript with Node built-ins only, so it starts without a build step.
//
// Claude Code calls the tool with { tool_name, input, tool_use_id } and expects one text block holding
// JSON: {"behavior":"allow","updatedInput":{...}} or {"behavior":"deny","message":"..."}.
import http from "node:http";
import { createInterface } from "node:readline";

const BRIDGE_URL = process.env.RELAYROOM_APPROVAL_URL ?? "";
const SECRET = process.env.RELAYROOM_APPROVAL_SECRET ?? "";
const TOOL = "approval_prompt";

const TOOL_DEF = {
  name: TOOL,
  description:
    "RelayRoom permission prompt. Called by Claude Code itself when a tool use needs permission; asks a human in the RelayRoom project room.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string", description: "The tool that needs permission" },
      input: { type: "object", description: "The tool's input", additionalProperties: true },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function deny(message) {
  return { behavior: "deny", message };
}

/** POSTs to the adapter's bridge. No client-side timeout: the adapter owns the deadline. */
function askAdapter(body) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL("/approval", BRIDGE_URL);
    } catch {
      return resolve(deny("RelayRoom approval bridge is not configured; denied."));
    }
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), authorization: `Bearer ${SECRET}` },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(text);
            if (res.statusCode === 200 && (parsed.behavior === "allow" || parsed.behavior === "deny")) return resolve(parsed);
          } catch {
            // fall through
          }
          resolve(deny(`RelayRoom approval bridge error (HTTP ${res.statusCode}); denied.`));
        });
      },
    );
    req.on("error", () => resolve(deny("RelayRoom approval bridge unreachable; denied.")));
    req.end(data);
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "relayroom-approvals", version: "0.1.0" },
        },
      });
    case "ping":
      return isRequest && send({ jsonrpc: "2.0", id, result: {} });
    case "tools/list":
      return send({ jsonrpc: "2.0", id, result: { tools: [TOOL_DEF] } });
    case "tools/call": {
      if (params?.name !== TOOL) {
        return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: `Unknown tool ${params?.name}` }] } });
      }
      const args = params.arguments ?? {};
      const decision = await askAdapter({
        tool_name: typeof args.tool_name === "string" ? args.tool_name : "",
        input: args.input && typeof args.input === "object" ? args.input : {},
        tool_use_id: typeof args.tool_use_id === "string" ? args.tool_use_id : null,
      });
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(decision) }] } });
    }
    default:
      if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  handle(msg).catch((err) => {
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(err?.message ?? err) } });
  });
});
rl.on("close", () => process.exit(0));
