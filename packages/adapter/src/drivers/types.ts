import type { ObservedCommand, PermissionProfile, RunEventType } from "@relayroom/protocol";

export interface DriverEvent {
  type: RunEventType;
  text: string;
}

export interface ToolPermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string | null;
}

/** Provider-neutral answer to a permission prompt. Drivers translate it to the provider's format. */
export type ToolPermissionDecision = { allow: true } | { allow: false; message: string };

export interface RunOptions {
  prompt: string;
  cwd: string;
  permission: PermissionProfile;
  signal: AbortSignal;
  timeoutMs: number;
  onEvent: (e: DriverEvent) => void;
  /** Environment for the child process. The adapter strips its own credentials from it. */
  env: NodeJS.ProcessEnv;
  /**
   * Human-in-the-loop: when set (edit runs on an adapter with approvals enabled), a driver that
   * supports it routes permission prompts here instead of denying them. The callback applies the
   * adapter's local cap, asks the room and resolves allow/deny; it always settles (timeout, cancel).
   */
  approvals?: {
    request(req: ToolPermissionRequest): Promise<ToolPermissionDecision>;
    /** Upper bound for one decision, so the provider's own tool timeout can be set above it. */
    timeoutMs: number;
  };
}

export interface RunResult {
  outcome: "succeeded" | "failed" | "cancelled";
  exitCode: number | null;
  /** Provider session/thread id, when the provider reports one. */
  executionId: string | null;
  finalText: string;
  errorMessage: string | null;
  commands: ObservedCommand[];
  /** Tool uses the provider's permission system refused (surfaced to humans for approval decisions). */
  permissionDenials: string[];
}

export interface DetectResult {
  bin: string;
  version: string | null;
  /**
   * Whether the provider will actually grant file edits on this machine, when the driver can check
   * without a model call. false = it only runs read-only here; null/undefined = not determined.
   */
  canEdit?: boolean | null;
  /** Human-readable explanation when canEdit is false. */
  editNote?: string;
}

/**
 * One provider integration. Implementations live in their own module and translate the provider's
 * documented headless interface into the generic RunResult; nothing provider-specific leaks out.
 */
export interface ProviderDriver {
  readonly id: "claude-code" | "codex";
  readonly label: string;
  /** Static capability facts about this integration. `verified` is decided by a local self-test. */
  readonly capabilities: { progressEvents: boolean; cancel: boolean; edit: boolean; approvals?: boolean };
  detect(): Promise<DetectResult | null>;
  run(opts: RunOptions): Promise<RunResult>;
}
