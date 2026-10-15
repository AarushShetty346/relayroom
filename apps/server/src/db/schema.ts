import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const pk = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);

export const users = pgTable("users", {
  id: pk(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const projects = pgTable("projects", {
  id: pk(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id),
  taskCounter: integer("task_counter").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "member"] }).notNull(),
    joinedAt: ts("joined_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index("members_user_idx").on(t.userId)],
);

export const invites = pgTable("invites", {
  id: pk(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull().unique(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  expiresAt: ts("expires_at").notNull(),
  maxUses: integer("max_uses").notNull(),
  uses: integer("uses").notNull().default(0),
  revokedAt: ts("revoked_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const agents = pgTable(
  "agents",
  {
    id: pk(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    handle: text("handle").notNull(),
    displayName: text("display_name").notNull(),
    provider: text("provider", { enum: ["claude-code", "codex", "custom"] }).notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    acceptFrom: text("accept_from", { enum: ["owner", "members"] }).notNull().default("members"),
    tokenHash: text("token_hash").notNull().unique(),
    revokedAt: ts("revoked_at"),
    // Live state reported by the adapter. Never trusted for authorization.
    connected: boolean("connected").notNull().default(false),
    lastHeartbeatAt: ts("last_heartbeat_at"),
    providerVersion: text("provider_version"),
    capabilities: jsonb("capabilities").$type<{
      progressEvents: boolean;
      cancel: boolean;
      edit: boolean;
      verified: boolean;
      approvals?: boolean;
    }>(),
    maxPermission: text("max_permission", { enum: ["read-only", "edit"] }),
    repo: jsonb("repo"),
    lastEvent: text("last_event"),
    lastEventAt: ts("last_event_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agents_project_handle_uq").on(t.projectId, t.handle)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: pk(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    acceptanceCriteria: jsonb("acceptance_criteria").$type<string[]>().notNull().default([]),
    status: text("status", {
      enum: ["queued", "assigned", "running", "awaiting_review", "completed", "failed", "cancelled", "blocked"],
    })
      .notNull()
      .default("queued"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id),
    branch: text("branch"),
    commit: text("commit"),
    lastResult: text("last_result"),
    sourceMessageId: uuid("source_message_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tasks_project_number_uq").on(t.projectId, t.number), index("tasks_project_idx").on(t.projectId)],
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: pk(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorType: text("actor_type", { enum: ["user", "agent", "system"] }).notNull(),
    actorId: uuid("actor_id"),
    actorName: text("actor_name").notNull(),
    note: text("note").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("task_events_task_idx").on(t.taskId)],
);

export const dispatches = pgTable(
  "dispatches",
  {
    id: pk(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    messageId: uuid("message_id"),
    kind: text("kind", { enum: ["mention", "task"] }).notNull(),
    instruction: text("instruction").notNull(),
    context: jsonb("context").notNull().default([]),
    permission: text("permission", { enum: ["read-only", "edit"] }).notNull(),
    expectedCommit: text("expected_commit"),
    status: text("status", {
      enum: ["pending", "running", "succeeded", "failed", "cancelled", "rejected", "interrupted"],
    })
      .notNull()
      .default("pending"),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    executionId: text("execution_id"),
    exitCode: integer("exit_code"),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("dispatches_agent_status_idx").on(t.agentId, t.status),
    index("dispatches_task_idx").on(t.taskId),
    // At most one running dispatch per agent: the adapter executes one at a time.
    uniqueIndex("dispatches_one_running_per_agent_uq")
      .on(t.agentId)
      .where(sql`status = 'running'`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: pk(),
    seq: bigserial("seq", { mode: "bigint" }).notNull().unique(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["human", "agent", "system", "event", "task"] }).notNull(),
    authorType: text("author_type", { enum: ["user", "agent", "system"] }).notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    replyToId: uuid("reply_to_id"),
    mentions: jsonb("mentions").$type<{ type: "user" | "agent"; id: string; handle: string }[]>().notNull().default([]),
    dispatchId: uuid("dispatch_id"),
    taskId: uuid("task_id"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    clientNonce: uuid("client_nonce"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("messages_project_seq_idx").on(t.projectId, t.seq),
    index("messages_task_idx").on(t.taskId),
    uniqueIndex("messages_nonce_uq").on(t.projectId, t.authorUserId, t.clientNonce),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    dispatchId: uuid("dispatch_id")
      .notNull()
      .references(() => dispatches.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    text: text("text").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("run_events_dispatch_seq_uq").on(t.dispatchId, t.seq)],
);

export const handoffs = pgTable(
  "handoffs",
  {
    id: pk(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dispatchId: uuid("dispatch_id").references(() => dispatches.id, { onDelete: "set null" }),
    fromType: text("from_type", { enum: ["user", "agent", "system"] }).notNull(),
    fromId: uuid("from_id"),
    fromName: text("from_name").notNull(),
    toType: text("to_type", { enum: ["user", "agent"] }),
    toId: uuid("to_id"),
    toName: text("to_name"),
    note: text("note").notNull().default(""),
    data: jsonb("data").notNull(),
    diff: text("diff"),
    diffTruncated: boolean("diff_truncated").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("handoffs_task_idx").on(t.taskId)],
);

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: pk(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["decision", "convention", "constraint", "accepted_approach", "rejected_approach", "open_question", "fact"],
    }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    status: text("status", { enum: ["verified", "suggested", "assumption"] }).notNull(),
    sourceType: text("source_type", { enum: ["user", "agent", "system"] }).notNull(),
    sourceId: uuid("source_id"),
    sourceName: text("source_name").notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    messageId: uuid("message_id"),
    verifiedBy: uuid("verified_by").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("memory_project_idx").on(t.projectId)],
);

/** Human-in-the-loop decisions for agent actions outside the adapter's allowlist. */
export const approvals = pgTable(
  "approvals",
  {
    // Chosen by the adapter, so a re-sent request after a reconnect maps to the same row.
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    dispatchId: uuid("dispatch_id")
      .notNull()
      .references(() => dispatches.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    summary: text("summary").notNull(),
    detail: text("detail").notNull(),
    status: text("status", { enum: ["pending", "approved", "denied", "expired", "cancelled"] })
      .notNull()
      .default("pending"),
    reason: text("reason"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedByName: text("decided_by_name"),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    decidedAt: ts("decided_at"),
  },
  (t) => [index("approvals_dispatch_idx").on(t.dispatchId), index("approvals_project_status_idx").on(t.projectId, t.status)],
);
