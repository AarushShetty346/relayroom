import { z } from "zod";

export const TaskStatus = z.enum([
  "queued",
  "assigned",
  "running",
  "awaiting_review",
  "completed",
  "failed",
  "cancelled",
  "blocked",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Who is asking for a transition. Agents act only through run results reported by their adapter. */
export type TransitionActor = "human" | "agent" | "system";

interface Rule {
  to: TaskStatus;
  by: readonly TransitionActor[];
}

const H = ["human"] as const;
const HS = ["human", "system"] as const;
const S = ["system"] as const;
const AS = ["agent", "system"] as const;
const HAS = ["human", "agent", "system"] as const;

/**
 * The task state machine. `running` is entered only by the system when an adapter accepts a dispatch
 * (or a human marks their own work as started). An agent can move a running task to awaiting_review,
 * failed or blocked — never to completed. Completion is a human review decision.
 */
const RULES: Record<TaskStatus, readonly Rule[]> = {
  queued: [
    { to: "assigned", by: HS },
    { to: "cancelled", by: H },
    { to: "blocked", by: H },
  ],
  assigned: [
    { to: "running", by: HS },
    { to: "queued", by: H },
    { to: "assigned", by: HS },
    { to: "blocked", by: H },
    { to: "cancelled", by: H },
    { to: "failed", by: S },
  ],
  running: [
    { to: "awaiting_review", by: HAS },
    { to: "failed", by: AS },
    { to: "blocked", by: HAS },
    { to: "cancelled", by: H },
  ],
  awaiting_review: [
    { to: "completed", by: H },
    { to: "assigned", by: H },
    { to: "failed", by: H },
    { to: "blocked", by: H },
    { to: "cancelled", by: H },
  ],
  blocked: [
    { to: "assigned", by: HS },
    { to: "queued", by: H },
    { to: "cancelled", by: H },
  ],
  failed: [
    { to: "assigned", by: HS },
    { to: "queued", by: H },
    { to: "cancelled", by: H },
  ],
  completed: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus, actor: TransitionActor): boolean {
  return RULES[from].some((r) => r.to === to && r.by.includes(actor));
}

export function allowedTransitions(from: TaskStatus, actor: TransitionActor): TaskStatus[] {
  return RULES[from].filter((r) => r.by.includes(actor)).map((r) => r.to);
}

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["completed", "cancelled"];

export const DispatchStatus = z.enum([
  /** Created, waiting for the adapter to accept it. Re-sent on reconnect. */
  "pending",
  /** Accepted by the adapter; execution started. Never re-sent. */
  "running",
  "succeeded",
  "failed",
  "cancelled",
  /** Adapter refused it (busy, policy, unsupported). */
  "rejected",
  /** The adapter disappeared while running. Not retried automatically. */
  "interrupted",
]);
export type DispatchStatus = z.infer<typeof DispatchStatus>;

export const ACTIVE_DISPATCH_STATUSES: readonly DispatchStatus[] = ["pending", "running"];
