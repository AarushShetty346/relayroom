import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import {
  ADAPTER_NAMESPACE,
  ADAPTER_PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  parseReportedHandoff,
  type AdapterToServerEvents,
  type ApprovalDecision,
  type ApprovalRequest,
  type DispatchPayload,
  type HandoffReported,
  type PermissionProfile,
  type RunComplete,
  type ServerToAdapterEvents,
} from "@relayroom/protocol";
import type { AdapterConfig } from "./config.js";
import type { ProviderDriver, RunResult, ToolPermissionDecision, ToolPermissionRequest } from "./drivers/types.js";
import { approvalPolicy, summarizeToolUse } from "./approval-policy.js";
import { displayPath } from "./paths.js";
import { checkBase, collectGitInfo, diffSince, headCommit, isGitRepo } from "./git.js";
import { Journal } from "./journal.js";
import { renderPrompt } from "./prompt.js";
import { Redactor } from "./redact.js";
import { ensureTaskWorktree } from "./worktree.js";

export const ADAPTER_VERSION = "0.1.0";
/** Extra time the adapter waits past a request's timeout for the server's own expiry to arrive. */
export const APPROVAL_GRACE_MS = 15_000;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

type AdapterSocket = Socket<ServerToAdapterEvents, AdapterToServerEvents>;

interface Current {
  dispatchId: string;
  abort: AbortController;
}

interface PendingApproval {
  req: ApprovalRequest;
  settle: (d: ApprovalDecision) => void;
}

type Emit = (type: "status" | "text" | "tool" | "command" | "file_change" | "error", text: string) => void;

/**
 * The local adapter process: one outbound authenticated connection, one agent, one registered
 * directory. It executes at most one dispatch at a time, only after the server grants it, and never
 * the same dispatch twice (local journal + server-side single grant).
 */
export class Adapter {
  private socket: AdapterSocket | null = null;
  private current: Current | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private journal: Journal;
  private redactor: Redactor;
  private agentName = "agent";
  private providerVersion: string | null = null;
  private providerCanEdit: boolean | null = null;
  private stopped = false;
  /** Approval requests waiting for a human; re-sent after a reconnect (the server dedupes by id). */
  private pendingApprovals = new Map<string, PendingApproval>();
  /** Resolves when the in-flight run (if any) has fully finished reporting. */
  idle: Promise<void> = Promise.resolve();

  constructor(
    private cfg: AdapterConfig,
    private driver: ProviderDriver,
    private log: Logger,
  ) {
    this.journal = new Journal(cfg.journalPath);
    this.redactor = new Redactor(cfg.projectDir);
  }

  /** Approvals need the owner's opt-in and a driver that can route permission prompts to us. */
  get approvalsEnabled(): boolean {
    return this.cfg.approvals === true && this.driver.capabilities.approvals === true;
  }

  /** The adapter's real cap: its config, lowered when the provider itself only runs read-only here. */
  get effectiveMaxPermission(): PermissionProfile {
    return this.cfg.maxPermission === "edit" && this.providerCanEdit !== false ? "edit" : "read-only";
  }

  get verified(): boolean {
    return this.journal.selfTest(`${this.driver.id}@${this.providerVersion ?? "unknown"}`)?.ok === true;
  }

  async start(): Promise<void> {
    const found = await this.driver.detect();
    if (!found) this.log.warn(`${this.driver.label} CLI not found; dispatches will fail until it is installed`);
    this.providerVersion = found?.version ?? null;
    this.providerCanEdit = found?.canEdit ?? null;
    if (this.providerCanEdit === false && this.cfg.maxPermission === "edit") {
      this.log.warn(`${found?.editNote ?? `${this.driver.label} cannot edit files on this machine`}. This adapter will accept read-only work only.`);
    }

    const socket: AdapterSocket = io(this.cfg.serverUrl + ADAPTER_NAMESPACE, {
      auth: { token: this.cfg.token },
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
      forceNew: true,
    });
    this.socket = socket;

    socket.on("connect", () => {
      this.log.info("connected to RelayRoom");
      void this.hello();
    });
    socket.on("connect_error", (err) => {
      this.log.warn(`connection failed: ${err.message}`);
      if (err.message === "unauthorized") {
        this.log.error("the agent token was rejected (revoked or rotated). Stopping.");
        void this.stop();
      }
    });
    socket.on("disconnect", (reason) => this.log.warn(`disconnected: ${reason}`));
    socket.on("revoked", ({ reason }) => {
      this.log.error(`server closed this adapter: ${reason}`);
      void this.stop();
    });
    socket.on("dispatch", (p) => void this.onDispatch(p));
    socket.on("approval:decision", (d) => this.pendingApprovals.get(d.approvalId)?.settle(d));
    socket.on("dispatch:cancel", ({ dispatchId }) => {
      if (this.current?.dispatchId === dispatchId) {
        this.log.info("cancellation requested", { dispatchId });
        this.current.abort.abort();
      }
    });

    this.heartbeat = setInterval(() => void this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.current?.abort.abort();
    await this.idle.catch(() => {});
    this.socket?.disconnect();
  }

  private async hello(): Promise<void> {
    const s = this.socket!;
    const repo = await collectGitInfo(this.cfg.projectDir).catch(() => null);
    const res = await s.timeout(15_000).emitWithAck("hello", {
      protocolVersion: ADAPTER_PROTOCOL_VERSION,
      adapterVersion: ADAPTER_VERSION,
      provider: this.driver.id,
      providerVersion: this.providerVersion,
      capabilities: {
        ...this.driver.capabilities,
        edit: this.driver.capabilities.edit && this.providerCanEdit !== false,
        verified: this.verified,
        approvals: this.approvalsEnabled,
      },
      maxPermission: this.effectiveMaxPermission,
      activeDispatchIds: this.current ? [this.current.dispatchId] : [],
      journaledDispatchIds: this.journal.accepted().slice(-1000),
      repo,
    }).catch((err: Error) => ({ ok: false, error: err.message }) as { ok: boolean; error?: string; agent?: { handle: string } });
    if (!res.ok) {
      this.log.error(`hello rejected: ${res.error ?? "unknown"}`);
      return;
    }
    if (res.agent) this.agentName = `@${res.agent.handle}`;
    this.log.info(`registered as ${this.agentName}`);
    for (const pending of this.pendingApprovals.values()) void this.sendApprovalRequest(pending);
    await this.flushUnsent();
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.socket?.connected) return;
    const repo = await collectGitInfo(this.cfg.projectDir).catch(() => null);
    this.socket.emit("heartbeat", {
      state: this.current ? "busy" : "idle",
      activeDispatchIds: this.current ? [this.current.dispatchId] : [],
      repo,
    });
  }

  /** Local policy runs before anything else. Returns a refusal reason or null. */
  private policyRefusal(p: DispatchPayload): string | null {
    if (p.permission === "edit" && this.cfg.maxPermission === "edit" && this.providerCanEdit === false)
      return `${this.driver.label} only runs read-only on this machine, so it cannot edit files`;
    if (p.permission === "edit" && this.cfg.maxPermission !== "edit") return "this adapter's local policy allows read-only work only";
    if (this.cfg.allowedRequesters && !this.cfg.allowedRequesters.includes(p.requestedBy.username.toLowerCase()))
      return `@${p.requestedBy.username} is not on this adapter's allowed requester list`;
    return null;
  }

  private async onDispatch(p: DispatchPayload): Promise<void> {
    const s = this.socket;
    if (!s || this.stopped) return;
    if (this.current) return; // busy: the server re-sends when we report idle
    if (this.journal.has(p.dispatchId)) {
      await s.timeout(10_000).emitWithAck("dispatch:reject", { dispatchId: p.dispatchId, reason: "already executed by this adapter" }).catch(() => {});
      return;
    }
    const refusal = this.policyRefusal(p);
    if (refusal) {
      this.log.warn("refused dispatch", { dispatchId: p.dispatchId, reason: refusal });
      await s.timeout(10_000).emitWithAck("dispatch:reject", { dispatchId: p.dispatchId, reason: refusal }).catch(() => {});
      return;
    }
    // Claim the slot before asking, so a second delivery cannot race this one.
    const current: Current = { dispatchId: p.dispatchId, abort: new AbortController() };
    this.current = current;
    let granted = false;
    try {
      const ack = await s.timeout(15_000).emitWithAck("dispatch:accept", { dispatchId: p.dispatchId });
      granted = ack.ok;
      if (!ack.ok) this.log.info(`dispatch not granted: ${ack.error ?? ""}`, { dispatchId: p.dispatchId });
    } catch {
      granted = false; // no answer: do not run; the server will re-send if it is still pending
    }
    if (!granted) {
      this.current = null;
      return;
    }
    this.journal.recordAccepted(p.dispatchId);
    this.idle = this.execute(p, current).finally(() => {
      if (this.current === current) this.current = null;
      void this.sendHeartbeat();
    });
    await this.idle;
  }

  private async execute(p: DispatchPayload, current: Current): Promise<void> {
    const started = Date.now();
    let seq = 0;
    const emit: Emit = (type, text) => {
      this.socket?.emit("run:event", { dispatchId: p.dispatchId, seq: seq++, type, text: this.redactor.redact(text).slice(0, 8000) }, () => {});
    };

    let cwd = this.cfg.projectDir;
    let result: RunResult;
    let baseCommit: string | null = null;
    let approvalsOffered = false;
    try {
      const repo = await isGitRepo(this.cfg.projectDir);
      if (this.cfg.worktrees && repo && p.kind === "task" && p.taskId && p.permission === "edit") {
        const wt = await ensureTaskWorktree(this.cfg.projectDir, p.taskId);
        cwd = wt.dir;
        emit("status", `${wt.created ? "Created" : "Using"} worktree on branch ${wt.branch}`);
      }
      baseCommit = repo ? await headCommit(cwd) : null;
      emit("status", `Starting ${this.driver.label} (${p.permission})`);
      // Local cap: the effective permission never exceeds this adapter's own maximum.
      const effective: PermissionProfile = p.permission === "edit" && this.effectiveMaxPermission === "edit" ? "edit" : "read-only";
      const runCwd = cwd;
      const approvals =
        this.approvalsEnabled && effective === "edit"
          ? {
              timeoutMs: this.cfg.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
              request: (req: ToolPermissionRequest) => this.askRoom(p, runCwd, effective, req, emit, current.abort.signal),
            }
          : undefined;
      approvalsOffered = !!approvals;
      result = await this.driver.run({
        ...(approvals ? { approvals } : {}),
        prompt: renderPrompt(p, this.agentName),
        cwd,
        permission: p.permission,
        signal: current.abort.signal,
        timeoutMs: this.cfg.timeoutMs,
        onEvent: (e) => emit(e.type, e.text),
        env: childEnv(),
      });
    } catch (err) {
      result = {
        outcome: "failed",
        exitCode: null,
        executionId: null,
        finalText: "",
        errorMessage: `Adapter error: ${(err as Error).message}`,
        commands: [],
        permissionDenials: [],
      };
    }

    const git = await collectGitInfo(cwd).catch(() => null);
    const { diff, truncated } = git ? await diffSince(cwd, baseCommit).catch(() => ({ diff: null, truncated: false })) : { diff: null, truncated: false };
    const baseCheck = git && p.expectedCommit ? await checkBase(cwd, p.expectedCommit).catch(() => null) : null;
    const { cleanText, reported } = parseReportedHandoff(result.finalText);
    let finalText = cleanText;
    if (result.permissionDenials.length) {
      finalText +=
        (approvalsOffered
          ? `\n\nNot allowed during this run (local policy, a human's decision, or no decision in time):\n`
          : `\n\nBlocked by the local permission policy (needs a human decision):\n`) +
        result.permissionDenials.map((d) => `- ${d}`).join("\n");
    }

    const r = this.redactor;
    const completion: RunComplete = {
      dispatchId: p.dispatchId,
      outcome: result.outcome,
      exitCode: result.exitCode,
      executionId: result.executionId,
      finalText: r.redact(finalText).slice(0, 60_000),
      errorMessage: result.errorMessage ? r.redact(result.errorMessage).slice(0, 4000) : null,
      durationMs: Date.now() - started,
      observed: {
        commands: result.commands.slice(0, 200).map((c) => ({ ...c, command: r.redact(c.command) })),
        baseCommit,
        git,
        diff: diff ? r.redact(diff) : null,
        diffTruncated: truncated,
        baseCheck,
      },
      reported: reported ? redactReport(reported, r) : null,
    };
    this.log.info(`run ${completion.outcome}`, { dispatchId: p.dispatchId, exitCode: completion.exitCode, ms: completion.durationMs });
    this.journal.queueCompletion(completion);
    await this.sendCompletion(completion);
  }

  /**
   * A permission prompt from the running agent. The local cap is applied first; only what passes it
   * is put to the room. Always settles: on a decision, the request's timeout, or the run's cancellation.
   */
  private async askRoom(
    p: DispatchPayload,
    cwd: string,
    permission: PermissionProfile,
    req: ToolPermissionRequest,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<ToolPermissionDecision> {
    const summary = this.redactor.redact(summarizeToolUse(req.toolName, req.input, (x) => displayPath(cwd, x))).slice(0, 2000);
    const policy = approvalPolicy({ permission, cwd, toolName: req.toolName, input: req.input });
    if (!policy.ask) {
      emit("status", `Denied by local policy: ${summary} (${policy.reason})`);
      return { allow: false, message: `Denied by the RelayRoom adapter's local policy: ${policy.reason}. This cannot be approved; continue without it.` };
    }
    if (signal.aborted) return { allow: false, message: "The run is being cancelled." };
    const request: ApprovalRequest = {
      approvalId: randomUUID(),
      dispatchId: p.dispatchId,
      toolName: req.toolName.slice(0, 200) || "unknown",
      summary,
      detail: this.redactor.redact(JSON.stringify(req.input, null, 2) ?? "{}").slice(0, 8000),
      timeoutMs: this.cfg.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    };
    emit("status", `Waiting for approval: ${summary}`);
    this.log.info("waiting for approval", { dispatchId: p.dispatchId, approvalId: request.approvalId, tool: request.toolName });
    const d = await this.waitForDecision(request, signal);
    const who = d.decidedBy?.name ?? "a human";
    const note = d.reason ? d.reason.replace(/\s+/g, " ").slice(0, 500) : "";
    switch (d.status) {
      case "approved":
        emit("status", `Approved by ${who}: ${summary}`);
        return { allow: true };
      case "denied":
        emit("status", `Denied by ${who}: ${summary}`);
        return {
          allow: false,
          message: `${who} denied this in RelayRoom${note ? ` with the note: "${note}"` : ""}. Do not try to get the same effect another way; continue without it, or stop and explain what you need.`,
        };
      case "expired":
        emit("status", `No decision in time, denied: ${summary}`);
        return { allow: false, message: "No one in RelayRoom decided in time, so this was denied. Continue without it, or stop and explain what you need." };
      default:
        emit("status", `Approval request closed (${note || "cancelled"}): ${summary}`);
        return { allow: false, message: `This request was not decided (${note || "cancelled"}); denied.` };
    }
  }

  private waitForDecision(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const local = (status: "expired" | "cancelled", reason: string): ApprovalDecision => ({
        approvalId: req.approvalId,
        dispatchId: req.dispatchId,
        status,
        reason,
        decidedBy: null,
      });
      let done = false;
      const settle = (d: ApprovalDecision) => {
        if (done || d.approvalId !== req.approvalId) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pendingApprovals.delete(req.approvalId);
        resolve(d);
      };
      const onAbort = () => settle(local("cancelled", "the run was cancelled"));
      const timer = setTimeout(() => settle(local("expired", "no decision in time")), req.timeoutMs + APPROVAL_GRACE_MS);
      signal.addEventListener("abort", onAbort, { once: true });
      const pending: PendingApproval = { req, settle };
      this.pendingApprovals.set(req.approvalId, pending);
      void this.sendApprovalRequest(pending);
    });
  }

  private async sendApprovalRequest(pending: PendingApproval): Promise<void> {
    const s = this.socket;
    if (!s?.connected) return; // re-sent after the next successful hello
    try {
      const ack = await s.timeout(15_000).emitWithAck("approval:request", pending.req);
      if (ack.decision) pending.settle(ack.decision);
      else if (!ack.ok) {
        this.log.warn(`approval request refused: ${ack.error ?? ""}`, { approvalId: pending.req.approvalId });
        const { approvalId, dispatchId } = pending.req;
        pending.settle({ approvalId, dispatchId, status: "cancelled", reason: `the server refused the request: ${ack.error ?? "unknown"}`, decidedBy: null });
      }
    } catch {
      // Not acknowledged: stays pending and is re-sent after reconnect, or times out locally.
    }
  }

  private async sendCompletion(c: RunComplete): Promise<boolean> {
    const s = this.socket;
    if (!s?.connected) return false;
    try {
      const ack = await s.timeout(20_000).emitWithAck("run:complete", c);
      if (ack.ok) {
        this.journal.markSent(c.dispatchId);
        return true;
      }
      this.log.warn(`completion rejected: ${ack.error ?? ""}`, { dispatchId: c.dispatchId });
      // A permanent rejection (unknown dispatch) would otherwise loop forever.
      if (ack.error === "Unknown dispatch" || ack.error?.startsWith("Dispatch is ")) this.journal.markSent(c.dispatchId);
    } catch {
      // Not acknowledged; kept in the journal and re-sent after reconnect.
    }
    return false;
  }

  private async flushUnsent(): Promise<void> {
    for (const c of this.journal.unsent()) {
      if (this.current?.dispatchId === c.dispatchId) continue;
      await this.sendCompletion(c);
    }
  }
}

function redactReport(rep: HandoffReported, r: Redactor): HandoffReported {
  const s = (x: string) => r.redact(x);
  return {
    summary: s(rep.summary),
    workCompleted: rep.workCompleted.map(s),
    testsRun: rep.testsRun.map(s),
    testResults: s(rep.testResults),
    unresolvedFailures: rep.unresolvedFailures.map(s),
    limitations: rep.limitations.map(s),
    nextAction: s(rep.nextAction),
    decisions: rep.decisions.map(s),
    openQuestions: rep.openQuestions.map(s),
  };
}

/** The provider needs its own auth from the environment, but never RelayRoom's credential. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.RELAYROOM_AGENT_TOKEN;
  return out;
}
