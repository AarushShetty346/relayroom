import { HEARTBEAT_TIMEOUT_MS } from "@relayroom/protocol";
import type {
  AgentDTO,
  DispatchDTO,
  GitInfo,
  HandoffDTO,
  Handoff,
  MemoryDTO,
  MessageDTO,
  TaskDTO,
} from "@relayroom/protocol";
import type { agents, dispatches, handoffs, memoryEntries, messages, tasks } from "../db/schema.js";

type Row<T extends { $inferSelect: unknown }> = T["$inferSelect"];

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function messageDTO(
  m: Row<typeof messages>,
  names: { userName?: string | null; agentName?: string | null },
): MessageDTO {
  const author =
    m.authorType === "user"
      ? { type: "user" as const, id: m.authorUserId, name: names.userName ?? "unknown user" }
      : m.authorType === "agent"
        ? { type: "agent" as const, id: m.authorAgentId, name: names.agentName ?? "removed agent" }
        : { type: "system" as const, id: null, name: "RelayRoom" };
  return {
    id: m.id,
    projectId: m.projectId,
    seq: m.seq.toString(),
    kind: m.kind,
    author,
    body: m.body,
    replyToId: m.replyToId,
    mentions: m.mentions,
    dispatchId: m.dispatchId,
    taskId: m.taskId,
    meta: m.meta,
    createdAt: m.createdAt.toISOString(),
  };
}

export function agentStatus(a: Row<typeof agents>, busy: boolean, now = Date.now()): AgentDTO["status"] {
  if (a.revokedAt || !a.connected || !a.lastHeartbeatAt) return "offline";
  if (now - a.lastHeartbeatAt.getTime() > HEARTBEAT_TIMEOUT_MS) return "offline";
  return busy ? "busy" : "online";
}

export function agentDTO(
  a: Row<typeof agents>,
  extra: { ownerName: string; activeDispatchId: string | null; activeTaskId: string | null },
): AgentDTO {
  return {
    id: a.id,
    projectId: a.projectId,
    handle: a.handle,
    displayName: a.displayName,
    provider: a.provider,
    ownerId: a.ownerId,
    ownerName: extra.ownerName,
    acceptFrom: a.acceptFrom,
    status: agentStatus(a, extra.activeDispatchId !== null),
    capabilities: a.capabilities ?? null,
    providerVersion: a.providerVersion,
    maxPermission: a.maxPermission,
    lastHeartbeatAt: iso(a.lastHeartbeatAt),
    lastEvent: a.lastEvent,
    lastEventAt: iso(a.lastEventAt),
    activeTaskId: extra.activeTaskId,
    activeDispatchId: extra.activeDispatchId,
    repo: (a.repo as GitInfo | null) ?? null,
    revokedAt: iso(a.revokedAt),
    createdAt: a.createdAt.toISOString(),
  };
}

export function dispatchDTO(d: Row<typeof dispatches>): DispatchDTO {
  return {
    id: d.id,
    projectId: d.projectId,
    agentId: d.agentId,
    taskId: d.taskId,
    messageId: d.messageId,
    kind: d.kind,
    status: d.status,
    permission: d.permission,
    requestedBy: d.requestedBy,
    executionId: d.executionId,
    exitCode: d.exitCode,
    error: d.error,
    createdAt: d.createdAt.toISOString(),
    startedAt: iso(d.startedAt),
    finishedAt: iso(d.finishedAt),
  };
}

export function taskDTO(t: Row<typeof tasks>, assigneeName: string | null, relatedMessageIds: string[] = []): TaskDTO {
  const assignee = t.assigneeAgentId
    ? { type: "agent" as const, id: t.assigneeAgentId, name: assigneeName ?? "agent" }
    : t.assigneeUserId
      ? { type: "user" as const, id: t.assigneeUserId, name: assigneeName ?? "user" }
      : null;
  return {
    id: t.id,
    projectId: t.projectId,
    number: t.number,
    title: t.title,
    description: t.description,
    acceptanceCriteria: t.acceptanceCriteria,
    status: t.status,
    createdBy: t.createdBy,
    assignee,
    branch: t.branch,
    commit: t.commit,
    lastResult: t.lastResult,
    relatedMessageIds,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function handoffDTO(h: Row<typeof handoffs>): HandoffDTO {
  return {
    id: h.id,
    taskId: h.taskId,
    dispatchId: h.dispatchId,
    from: { type: h.fromType, id: h.fromId, name: h.fromName },
    to: h.toType ? { type: h.toType, id: h.toId, name: h.toName ?? "" } : null,
    note: h.note,
    handoff: h.data as Handoff,
    diff: h.diff,
    diffTruncated: h.diffTruncated,
    createdAt: h.createdAt.toISOString(),
  };
}

export function memoryDTO(m: Row<typeof memoryEntries>): MemoryDTO {
  return {
    id: m.id,
    projectId: m.projectId,
    kind: m.kind,
    title: m.title,
    body: m.body,
    status: m.status,
    source: { type: m.sourceType, id: m.sourceId, name: m.sourceName },
    taskId: m.taskId,
    messageId: m.messageId,
    verifiedBy: m.verifiedBy,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}
