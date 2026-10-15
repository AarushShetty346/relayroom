import { z } from "zod";
import { ActorRef, AssigneeRef, GitInfo, Handle, Id, PermissionProfile, ProviderId } from "./common.js";
import { DispatchStatus, TaskStatus } from "./tasks.js";
import type { ApprovalStatus } from "./adapter.js";
import { Handoff } from "./handoff.js";

// ---------- Auth ----------

export const SignupBody = z.object({
  username: Handle,
  displayName: z.string().trim().min(1).max(64),
  password: z.string().min(10).max(256),
  /** Required when the server runs invite-only: a project invite code; the new account joins that project. */
  inviteCode: z.string().trim().min(16).max(128).optional(),
});

export type SignupMode = "open" | "invite";

/** Public, unauthenticated server settings the sign-in screen needs. */
export interface ServerInfoDTO {
  signupMode: SignupMode;
}
export const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });

export interface UserDTO {
  id: string;
  username: string;
  displayName: string;
}

// ---------- Projects ----------

export const CreateProjectBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).default(""),
});
export const CreateInviteBody = z.object({
  expiresInHours: z.number().int().min(1).max(24 * 14).default(72),
  maxUses: z.number().int().min(1).max(50).default(1),
});
export const AcceptInviteBody = z.object({ code: z.string().min(16).max(128) });

export interface ProjectDTO {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  role: "owner" | "member";
  createdAt: string;
}

export interface MemberDTO {
  userId: string;
  username: string;
  displayName: string;
  role: "owner" | "member";
  online: boolean;
}

export interface InviteDTO {
  id: string;
  /** Only present in the creation response. */
  code?: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  revokedAt: string | null;
}

// ---------- Agents ----------

export const CreateAgentBody = z.object({
  handle: Handle,
  displayName: z.string().trim().min(1).max(64),
  provider: ProviderId,
  acceptFrom: z.enum(["owner", "members"]).default("members"),
});

export type AgentStatus = "offline" | "online" | "busy";

export interface AgentDTO {
  id: string;
  projectId: string;
  handle: string;
  displayName: string;
  provider: z.infer<typeof ProviderId>;
  ownerId: string;
  ownerName: string;
  acceptFrom: "owner" | "members";
  status: AgentStatus;
  capabilities: {
    progressEvents: boolean;
    cancel: boolean;
    edit: boolean;
    verified: boolean;
    approvals?: boolean;
  } | null;
  providerVersion: string | null;
  maxPermission: z.infer<typeof PermissionProfile> | null;
  lastHeartbeatAt: string | null;
  lastEvent: string | null;
  lastEventAt: string | null;
  activeTaskId: string | null;
  activeDispatchId: string | null;
  repo: GitInfo | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface AgentTokenDTO {
  agent: AgentDTO;
  /** Shown exactly once. */
  token: string;
}

// ---------- Messages ----------

export const MessageKind = z.enum(["human", "agent", "system", "event", "task"]);
export type MessageKind = z.infer<typeof MessageKind>;

export const SendMessageBody = z.object({
  body: z.string().trim().min(1).max(8000),
  replyToId: Id.nullable().default(null),
  clientNonce: Id,
  /** Requested permission for any agent this message dispatches to. */
  permission: PermissionProfile.default("read-only"),
  /** Set after the user confirmed a concurrency warning. */
  confirmConcurrent: z.boolean().default(false),
});

export interface MentionDTO {
  type: "user" | "agent";
  id: string;
  handle: string;
}

export interface MessageDTO {
  id: string;
  projectId: string;
  /** Monotonic ordering key (stringified bigint). */
  seq: string;
  kind: MessageKind;
  author: ActorRef;
  body: string;
  replyToId: string | null;
  mentions: MentionDTO[];
  dispatchId: string | null;
  taskId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface SendMessageResult {
  message?: MessageDTO;
  dispatches: DispatchDTO[];
  /** Present when nothing was sent because the user must confirm first. */
  needsConfirmation?: { reasons: string[] };
  /** Agents that were mentioned but could not take the work. */
  unavailable: { handle: string; reason: string }[];
}

// ---------- Dispatches ----------

export interface DispatchDTO {
  id: string;
  projectId: string;
  agentId: string;
  taskId: string | null;
  messageId: string | null;
  kind: "mention" | "task";
  status: DispatchStatus;
  permission: z.infer<typeof PermissionProfile>;
  requestedBy: string;
  executionId: string | null;
  exitCode: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunEventDTO {
  dispatchId: string;
  seq: number;
  type: "status" | "text" | "tool" | "command" | "file_change" | "error";
  text: string;
  createdAt: string;
}

// ---------- Approvals ----------

export const DecideApprovalBody = z.object({
  decision: z.enum(["approve", "deny"]),
  reason: z.string().trim().max(1000).default(""),
});

export interface ApprovalDTO {
  id: string;
  projectId: string;
  dispatchId: string;
  agentId: string;
  toolName: string;
  summary: string;
  detail: string;
  status: ApprovalStatus;
  /** Who may decide: the dispatch requester, the agent owner, or the project owner. */
  requestedBy: string;
  agentOwnerId: string;
  reason: string | null;
  decidedBy: { id: string; name: string } | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

// ---------- Tasks ----------

export const CreateTaskBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(8000).default(""),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(30).default([]),
  sourceMessageId: Id.nullable().default(null),
});

export const AssignTaskBody = z.object({
  assignee: AssigneeRef.nullable(),
  /** For agent assignees: start running immediately. */
  start: z.boolean().default(true),
  permission: PermissionProfile.default("edit"),
  note: z.string().trim().max(4000).default(""),
  confirmConcurrent: z.boolean().default(false),
});

export const TransitionTaskBody = z.object({
  to: TaskStatus,
  note: z.string().trim().max(4000).default(""),
});

export const UpdateTaskBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(8000).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(30).optional(),
});

export interface TaskDTO {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  createdBy: string;
  assignee: (z.infer<typeof AssigneeRef> & { name: string }) | null;
  branch: string | null;
  commit: string | null;
  lastResult: string | null;
  relatedMessageIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface HandoffDTO {
  id: string;
  taskId: string;
  dispatchId: string | null;
  from: ActorRef;
  to: ActorRef | null;
  note: string;
  handoff: Handoff;
  diff: string | null;
  diffTruncated: boolean;
  createdAt: string;
}

export interface TaskDetailDTO {
  task: TaskDTO;
  handoffs: HandoffDTO[];
  dispatches: DispatchDTO[];
  history: { at: string; from: string | null; to: string; by: ActorRef; note: string }[];
}

// ---------- Memory ----------

export const MemoryKind = z.enum([
  "decision",
  "convention",
  "constraint",
  "accepted_approach",
  "rejected_approach",
  "open_question",
  "fact",
]);
export type MemoryKind = z.infer<typeof MemoryKind>;

/** verified: confirmed by a human. suggested: proposed by an agent. assumption: unresolved. */
export const MemoryStatus = z.enum(["verified", "suggested", "assumption"]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;

export const CreateMemoryBody = z.object({
  kind: MemoryKind,
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().max(8000).default(""),
  status: MemoryStatus.default("verified"),
  taskId: Id.nullable().default(null),
  messageId: Id.nullable().default(null),
});

export const UpdateMemoryBody = z.object({
  kind: MemoryKind.optional(),
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().trim().max(8000).optional(),
  status: MemoryStatus.optional(),
});

export interface MemoryDTO {
  id: string;
  projectId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  status: MemoryStatus;
  source: ActorRef;
  taskId: string | null;
  messageId: string | null;
  verifiedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------- Human socket events ----------

export interface ServerToClientEvents {
  "message:new": (m: MessageDTO) => void;
  "agent:updated": (a: AgentDTO) => void;
  "task:updated": (t: TaskDTO) => void;
  "dispatch:updated": (d: DispatchDTO) => void;
  "memory:updated": (m: MemoryDTO | { id: string; deleted: true }) => void;
  "presence:updated": (p: { userId: string; online: boolean }) => void;
  "run:event": (e: RunEventDTO) => void;
  "approval:updated": (a: ApprovalDTO) => void;
}

export interface ClientToServerEvents {
  "room:join": (p: { projectId: string }, ack: (r: { ok: boolean; error?: string }) => void) => void;
  "room:leave": (p: { projectId: string }) => void;
}
