import { z } from "zod";

export const Id = z.uuid();

/** Agent and user handles used in @mentions. Lowercase so mentions are case-insensitive. */
export const Handle = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z][a-z0-9_-]*$/, "lowercase letters, digits, - and _; must start with a letter");

export const ProviderId = z.enum(["claude-code", "codex", "custom"]);
export type ProviderId = z.infer<typeof ProviderId>;

/**
 * Permission profile requested for one dispatch. The local adapter caps this with its own
 * configured maximum: a server or chat message can never raise it.
 */
export const PermissionProfile = z.enum(["read-only", "edit"]);
export type PermissionProfile = z.infer<typeof PermissionProfile>;

export const ActorRef = z.object({
  type: z.enum(["user", "agent", "system"]),
  id: z.string().nullable(),
  name: z.string(),
});
export type ActorRef = z.infer<typeof ActorRef>;

export const AssigneeRef = z.object({
  type: z.enum(["user", "agent"]),
  id: Id,
});
export type AssigneeRef = z.infer<typeof AssigneeRef>;

export const GitChangedFile = z.object({
  path: z.string().max(1024),
  status: z.string().max(4),
});

export const GitInfo = z.object({
  isRepo: z.boolean(),
  branch: z.string().max(256).nullable(),
  head: z.string().max(64).nullable(),
  upstream: z.string().max(256).nullable(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  dirty: z.boolean(),
  changedFiles: z.array(GitChangedFile).max(500),
  collectedAt: z.string(),
});
export type GitInfo = z.infer<typeof GitInfo>;
