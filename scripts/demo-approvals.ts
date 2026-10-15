/**
 * Local UI demo for approvals — a SIMULATION. Seeds a project on a running server, connects a scripted
 * adapter (no real agent), starts a run and raises one approval request, then waits for a human to
 * Approve or Deny it in the browser and finishes the run with what it was told.
 *
 *   npm run demo:approvals -- http://localhost:4000
 *
 * Prints the throwaway login it created. Never point it at a shared server.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { io } from "socket.io-client";
import { ADAPTER_NAMESPACE, ADAPTER_PROTOCOL_VERSION, type ApprovalDecision } from "@relayroom/protocol";

const base = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
let cookie = "";
async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(base + p, {
    method,
    headers: { "x-relayroom-csrf": "1", origin: base, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) if (c.startsWith("rr_session=")) cookie = c.split(";")[0]!;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

const username = `demo${randomBytes(3).toString("hex")}`;
const password = randomBytes(12).toString("base64url");
await api("POST", "/api/auth/signup", { username, displayName: "Demo Owner", password });
const project = (await api("POST", "/api/projects", { name: "Approvals demo", description: "simulated adapter" })).project;
const reg = await api("POST", `/api/projects/${project.id}/agents`, { handle: "claude", displayName: "Claude", provider: "claude-code" });

const sock = io(base + ADAPTER_NAMESPACE, { transports: ["websocket"], auth: { token: reg.token }, forceNew: true });
await new Promise<void>((r) => sock.on("connect", () => r()));
const decided = new Promise<ApprovalDecision>((r) => sock.on("approval:decision", (d: ApprovalDecision) => r(d)));
const dispatched = new Promise<{ dispatchId: string }>((r) => sock.on("dispatch", (d: { dispatchId: string }) => r(d)));
await sock.emitWithAck("hello", {
  protocolVersion: ADAPTER_PROTOCOL_VERSION,
  adapterVersion: "demo",
  provider: "custom",
  providerVersion: "simulation",
  capabilities: { progressEvents: true, cancel: true, edit: true, verified: false, approvals: true },
  maxPermission: "edit",
  activeDispatchIds: [],
  journaledDispatchIds: [],
  repo: null,
});
sock.emit("heartbeat", { state: "idle", activeDispatchIds: [], repo: null });
await api("POST", `/api/projects/${project.id}/messages`, { body: "@claude add left-pad and run the tests", clientNonce: randomUUID(), permission: "edit" });
const { dispatchId } = await dispatched;
await sock.emitWithAck("dispatch:accept", { dispatchId });
await sock.emitWithAck("run:event", { dispatchId, seq: 0, type: "status", text: "Starting Claude Code (edit)" });
await sock.emitWithAck("run:event", { dispatchId, seq: 1, type: "status", text: "Waiting for approval: $ npm install left-pad" });
const approvalId = randomUUID();
await sock.emitWithAck("approval:request", {
  approvalId,
  dispatchId,
  toolName: "Bash",
  summary: "$ npm install left-pad",
  detail: JSON.stringify({ command: "npm install left-pad", description: "Install the left-pad package" }, null, 2),
  timeoutMs: 10 * 60_000,
});
console.log(JSON.stringify({ url: `${base}/`, username, password, projectId: project.id, dispatchId, approvalId }));
const d = await decided;
console.log(`DECISION ${d.status} by ${d.decidedBy?.name ?? "-"} reason=${d.reason ?? ""}`);
await sock.emitWithAck("run:event", { dispatchId, seq: 2, type: "status", text: `${d.status === "approved" ? "Approved" : "Denied"} by ${d.decidedBy?.name ?? "nobody"}` });
await sock.emitWithAck("run:complete", {
  dispatchId,
  outcome: "succeeded",
  exitCode: 0,
  executionId: "demo",
  finalText: d.status === "approved" ? "(simulated) Installed left-pad; tests pass." : "(simulated) Did not install left-pad, as instructed.",
  errorMessage: null,
  durationMs: 1000,
  observed: { commands: [], baseCommit: null, git: null, diff: null, diffTruncated: false, baseCheck: null },
  reported: null,
});
sock.disconnect();
