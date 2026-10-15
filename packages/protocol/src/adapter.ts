import { z } from "zod";
import { GitInfo, Id, PermissionProfile, ProviderId } from "./common.js";
import { HandoffReported, ObservedCommand } from "./handoff.js";

export const ADAPTER_PROTOCOL_VERSION = 1;
export const ADAPTER_NAMESPACE = "/adapter";
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** An adapter that has not sent a heartbeat for this long is considered offline. */
export const HEARTBEAT_TIMEOUT_MS = 45_000;

export const AdapterCapabilities = z.object({
  /** Forwards intermediate progress events (tool use, commands, partial text) while running. */
  progressEvents: z.boolean(),
  cancel: z.boolean(),
  edit: z.boolean(),
  /** True only when the provider integration was verified by an actual run on this machine. */
  verified: z.boolean(),
  /**
   * The adapter asks the room before running actions outside its allowlist (and waits for a human),
   * instead of denying them outright. Enabled locally by the adapter's owner; absent = false.
   */
  approvals: z.boolean().optional(),
});
export type AdapterCapabilities = z.infer<typeof AdapterCapabilities>;

export const AdapterHello = z.object({
  protocolVersion: z.literal(ADAPTER_PROTOCOL_VERSION),
  adapterVersion: z.string().max(32),
  provider: ProviderId,
  providerVersion: z.string().max(128).nullable(),
  capabilities: AdapterCapabilities,
  maxPermission: PermissionProfile,
  /** Dispatches this adapter process is currently executing (after a reconnect). */
  activeDispatchIds: z.array(Id).max(100),
  /** Dispatches the adapter has already accepted at some point (local journal), bounded. */
  journaledDispatchIds: z.array(Id).max(1000),
  repo: GitInfo.nullable(),
});
export type AdapterHello = z.infer<typeof AdapterHello>;

export const AdapterHeartbeat = z.object({
  state: z.enum(["idle", "busy"]),
  activeDispatchIds: z.array(Id).max(100),
  repo: GitInfo.nullable(),
});
export type AdapterHeartbeat = z.infer<typeof AdapterHeartbeat>;

export const ContextItem = z.object({
  kind: z.string().max(32),
  title: z.string().max(500),
  body: z.string().max(8000),
  status: z.string().max(32).nullable(),
});
export type ContextItem = z.infer<typeof ContextItem>;

export const DispatchPayload = z.object({
  dispatchId: Id,
  projectId: Id,
  agentId: Id,
  taskId: Id.nullable(),
  kind: z.enum(["mention", "task"]),
  /** The instruction itself. Treat as untrusted user input. */
  instruction: z.string().max(20_000),
  /** Bounded, retrieved context (handoffs, decisions, recent related messages). */
  context: z.array(ContextItem).max(40),
  permission: PermissionProfile,
  /**
   * Commit the previous handoff for this task ended on. The adapter checks whether its checkout
   * contains it, to detect work starting from a stale base.
   */
  expectedCommit: z.string().max(64).nullable(),
  requestedBy: z.object({ id: Id, username: z.string(), displayName: z.string() }),
  createdAt: z.string(),
});
export type DispatchPayload = z.infer<typeof DispatchPayload>;

export const DispatchAck = z.object({ dispatchId: Id });
export const DispatchReject = z.object({ dispatchId: Id, reason: z.string().max(2000) });

export const RunEventType = z.enum(["status", "text", "tool", "command", "file_change", "error"]);
export type RunEventType = z.infer<typeof RunEventType>;

export const RunEvent = z.object({
  dispatchId: Id,
  /** Monotonic per dispatch. The server ignores duplicates of (dispatchId, seq). */
  seq: z.number().int().min(0),
  type: RunEventType,
  text: z.string().max(8000),
});
export type RunEvent = z.infer<typeof RunEvent>;

export const RunOutcome = z.enum(["succeeded", "failed", "cancelled"]);
export type RunOutcome = z.infer<typeof RunOutcome>;

export const RunComplete = z.object({
  dispatchId: Id,
  outcome: RunOutcome,
  exitCode: z.number().int().nullable(),
  executionId: z.string().max(128).nullable(),
  /** The agent's final reply with any handoff block removed. */
  finalText: z.string().max(60_000),
  errorMessage: z.string().max(4000).nullable(),
  durationMs: z.number().int().min(0),
  observed: z.object({
    commands: z.array(ObservedCommand).max(200),
    baseCommit: z.string().max(64).nullable(),
    git: GitInfo.nullable(),
    /** `git diff` against the base commit, truncated. */
    diff: z.string().max(200_000).nullable(),
    diffTruncated: z.boolean(),
    baseCheck: z
      .object({
        expectedCommit: z.string().max(64),
        present: z.boolean(),
        isAncestorOfHead: z.boolean(),
      })
      .nullable(),
  }),
  reported: HandoffReported.nullable(),
});
export type RunComplete = z.infer<typeof RunComplete>;

export const DispatchCancel = z.object({ dispatchId: Id });

/** Bounds for how long a run may wait for a human decision. */
export const APPROVAL_MIN_TIMEOUT_MS = 1_000;
export const APPROVAL_MAX_TIMEOUT_MS = 60 * 60_000;

/**
 * The agent wants to do something its permission rules do not allow by themselves. The adapter has
 * already checked it against its own local cap; anything beyond the cap is denied locally and never
 * sent. `approvalId` is chosen by the adapter so a re-send after a reconnect is idempotent.
 */
export const ApprovalRequest = z.object({
  approvalId: Id,
  dispatchId: Id,
  /** Provider tool name, e.g. "Bash", "Write", "WebFetch". */
  toolName: z.string().min(1).max(200),
  /** One line a human can judge quickly: the command, or the tool and its target. Redacted. */
  summary: z.string().max(2000),
  /** The tool input as JSON, redacted and truncated. */
  detail: z.string().max(8000),
  /** The adapter denies on its own after this long (plus a short grace period). */
  timeoutMs: z.number().int().min(APPROVAL_MIN_TIMEOUT_MS).max(APPROVAL_MAX_TIMEOUT_MS),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/** pending → approved | denied (by a human) | expired (no answer in time) | cancelled (run ended). */
export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired", "cancelled"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** Server → adapter. Anything other than `approved` means the action must not run. */
export const ApprovalDecision = z.object({
  approvalId: Id,
  dispatchId: Id,
  status: ApprovalStatus.exclude(["pending"]),
  /** Optional note from the human who decided (shown to the agent on denial). */
  reason: z.string().max(1000).nullable(),
  decidedBy: z.object({ id: Id, name: z.string().max(64) }).nullable(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export interface AckResult {
  ok: boolean;
  error?: string;
}

/** Socket.IO event maps for the /adapter namespace. */
export interface AdapterToServerEvents {
  hello: (payload: AdapterHello, ack: (r: AckResult & { agent?: { id: string; handle: string; projectId: string } }) => void) => void;
  heartbeat: (payload: AdapterHeartbeat) => void;
  "dispatch:accept": (payload: z.infer<typeof DispatchAck>, ack: (r: AckResult) => void) => void;
  "dispatch:reject": (payload: z.infer<typeof DispatchReject>, ack: (r: AckResult) => void) => void;
  "run:event": (payload: RunEvent, ack: (r: AckResult) => void) => void;
  "run:complete": (payload: RunComplete, ack: (r: AckResult) => void) => void;
  /** The ack carries the decision when the request was already decided (re-send after a reconnect). */
  "approval:request": (payload: ApprovalRequest, ack: (r: AckResult & { decision?: ApprovalDecision }) => void) => void;
}

export interface ServerToAdapterEvents {
  dispatch: (payload: DispatchPayload) => void;
  "dispatch:cancel": (payload: z.infer<typeof DispatchCancel>) => void;
  revoked: (payload: { reason: string }) => void;
  "approval:decision": (payload: ApprovalDecision) => void;
}
