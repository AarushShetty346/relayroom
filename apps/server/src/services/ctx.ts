import type { FastifyBaseLogger } from "fastify";
import type { ApprovalDecision, DispatchPayload, ServerToClientEvents } from "@relayroom/protocol";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";

/** Real-time fan-out. Implemented by the Socket.IO layer; services never touch sockets directly. */
export interface Hub {
  toProject<E extends keyof ServerToClientEvents>(
    projectId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void;
  /** Returns false if the agent has no live adapter connection. */
  sendDispatch(agentId: string, payload: DispatchPayload): boolean;
  cancelDispatch(agentId: string, dispatchId: string): boolean;
  /** Returns false if the adapter is offline; it then gets the decision when it re-sends the request. */
  sendApprovalDecision(agentId: string, decision: ApprovalDecision): boolean;
  disconnectAgent(agentId: string, reason: string): void;
  isAgentConnected(agentId: string): boolean;
  onlineUserIds(projectId: string): Set<string>;
}

export interface Ctx {
  db: Db;
  hub: Hub;
  log: FastifyBaseLogger;
  config: Config;
}

type Effect = (ctx: Ctx) => void | Promise<void>;

/**
 * Side effects (broadcasts, adapter delivery) collected inside a transaction and run only after it
 * commits, so clients never see state that was rolled back.
 */
export class Outbox {
  private effects: Effect[] = [];
  add(effect: Effect): void {
    this.effects.push(effect);
  }
  async flush(ctx: Ctx): Promise<void> {
    const effects = this.effects;
    this.effects = [];
    for (const e of effects) {
      try {
        await e(ctx);
      } catch (err) {
        ctx.log.error({ err }, "outbox effect failed");
      }
    }
  }
}
