import type { Server as HttpServer } from "node:http";
import { Server, type Namespace, type Socket } from "socket.io";
import {
  ADAPTER_NAMESPACE,
  AdapterHeartbeat,
  AdapterHello,
  ApprovalRequest,
  type ApprovalDecision,
  DispatchAck,
  DispatchReject,
  RunComplete,
  RunEvent,
  type AdapterToServerEvents,
  type ClientToServerEvents,
  type DispatchPayload,
  type ServerToAdapterEvents,
  type ServerToClientEvents,
  type UserDTO,
} from "@relayroom/protocol";
import type { z } from "zod";
import type { Ctx, Hub } from "../services/ctx.js";
import { userForSessionToken } from "../services/auth.js";
import { requireMember } from "../services/projects.js";
import { adapterDisconnected, adapterHeartbeat, adapterHello, authenticateAgent } from "../services/agents.js";
import { acceptDispatch, completeDispatch, recordRunEvent, rejectDispatch } from "../services/dispatch.js";
import { requestApproval } from "../services/approvals.js";
import { SESSION_COOKIE, parseCookieHeader } from "../lib/cookies.js";

type HumanSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { user: UserDTO; projects: Set<string> }>;
type AdapterSocket = Socket<AdapterToServerEvents, ServerToAdapterEvents, Record<string, never>, { agentId: string; projectId: string; helloDone: boolean }>;

const room = (projectId: string) => `project:${projectId}`;

export class SocketHub implements Hub {
  io!: Server<ClientToServerEvents, ServerToClientEvents>;
  private adapterNs!: Namespace<AdapterToServerEvents, ServerToAdapterEvents>;
  private adapterSockets = new Map<string, AdapterSocket>();
  /** projectId → userId → number of open sockets in that project room. */
  private presence = new Map<string, Map<string, number>>();
  private ctx!: Ctx;

  attach(server: HttpServer, ctx: Ctx): void {
    this.ctx = ctx;
    this.io = new Server(server, {
      cors: { origin: ctx.config.webOrigins, credentials: true },
      maxHttpBufferSize: 2_000_000,
      pingInterval: 10_000,
      pingTimeout: 20_000,
    });
    this.setupHumans();
    this.setupAdapters();
  }

  // ---------- Hub ----------

  toProject<E extends keyof ServerToClientEvents>(projectId: string, event: E, ...args: Parameters<ServerToClientEvents[E]>): void {
    this.io?.to(room(projectId)).emit(event, ...args);
  }

  sendDispatch(agentId: string, payload: DispatchPayload): boolean {
    const s = this.adapterSockets.get(agentId);
    if (!s || !s.data.helloDone) return false;
    s.emit("dispatch", payload);
    return true;
  }

  cancelDispatch(agentId: string, dispatchId: string): boolean {
    const s = this.adapterSockets.get(agentId);
    if (!s) return false;
    s.emit("dispatch:cancel", { dispatchId });
    return true;
  }

  sendApprovalDecision(agentId: string, decision: ApprovalDecision): boolean {
    const s = this.adapterSockets.get(agentId);
    if (!s || !s.data.helloDone) return false;
    s.emit("approval:decision", decision);
    return true;
  }

  disconnectAgent(agentId: string, reason: string): void {
    const s = this.adapterSockets.get(agentId);
    if (!s) return;
    this.adapterSockets.delete(agentId);
    s.emit("revoked", { reason });
    s.disconnect(true);
  }

  isAgentConnected(agentId: string): boolean {
    return this.adapterSockets.get(agentId)?.data.helloDone === true;
  }

  onlineUserIds(projectId: string): Set<string> {
    return new Set(this.presence.get(projectId)?.keys() ?? []);
  }

  async close(): Promise<void> {
    if (this.io) await this.io.close();
  }

  // ---------- Humans ----------

  private setupHumans(): void {
    const { ctx } = this;
    this.io.use(async (socket, next) => {
      try {
        const origin = socket.handshake.headers.origin;
        if (origin && !ctx.config.webOrigins.includes(origin)) return next(new Error("origin not allowed"));
        const token = parseCookieHeader(socket.handshake.headers.cookie)[SESSION_COOKIE];
        const user = await userForSessionToken(ctx, token);
        if (!user) return next(new Error("unauthorized"));
        socket.data.user = user;
        socket.data.projects = new Set();
        next();
      } catch (err) {
        ctx.log.error({ err }, "socket auth failed");
        next(new Error("server error"));
      }
    });

    this.io.on("connection", (raw) => {
      const socket = raw as HumanSocket;
      socket.on("room:join", async (p, ack) => {
        const reply = typeof ack === "function" ? ack : () => {};
        try {
          if (typeof p?.projectId !== "string") return reply({ ok: false, error: "projectId required" });
          await requireMember(ctx.db, p.projectId, socket.data.user.id);
          await socket.join(room(p.projectId));
          if (!socket.data.projects.has(p.projectId)) {
            socket.data.projects.add(p.projectId);
            this.bumpPresence(p.projectId, socket.data.user.id, +1);
          }
          reply({ ok: true });
        } catch {
          reply({ ok: false, error: "not a member of this project" });
        }
      });
      socket.on("room:leave", (p) => {
        if (typeof p?.projectId !== "string" || !socket.data.projects.has(p.projectId)) return;
        socket.data.projects.delete(p.projectId);
        void socket.leave(room(p.projectId));
        this.bumpPresence(p.projectId, socket.data.user.id, -1);
      });
      socket.on("disconnect", () => {
        for (const pid of socket.data.projects) this.bumpPresence(pid, socket.data.user.id, -1);
        socket.data.projects.clear();
      });
    });
  }

  private bumpPresence(projectId: string, userId: string, delta: number): void {
    const m = this.presence.get(projectId) ?? new Map<string, number>();
    const before = m.get(userId) ?? 0;
    const after = Math.max(0, before + delta);
    if (after === 0) m.delete(userId);
    else m.set(userId, after);
    if (m.size) this.presence.set(projectId, m);
    else this.presence.delete(projectId);
    if ((before === 0) !== (after === 0)) this.toProject(projectId, "presence:updated", { userId, online: after > 0 });
  }

  // ---------- Adapters ----------

  private setupAdapters(): void {
    const { ctx } = this;
    this.adapterNs = this.io.of(ADAPTER_NAMESPACE) as unknown as Namespace<AdapterToServerEvents, ServerToAdapterEvents>;
    this.adapterNs.use(async (socket, next) => {
      try {
        const agent = await authenticateAgent(ctx, socket.handshake.auth?.token);
        if (!agent) return next(new Error("unauthorized"));
        socket.data.agentId = agent.id;
        socket.data.projectId = agent.projectId;
        socket.data.helloDone = false;
        next();
      } catch (err) {
        ctx.log.error({ err }, "adapter auth failed");
        next(new Error("server error"));
      }
    });

    this.adapterNs.on("connection", (raw) => {
      const socket = raw as AdapterSocket;
      const agentId = socket.data.agentId;
      const log = ctx.log.child({ agentId });
      const previous = this.adapterSockets.get(agentId);
      if (previous && previous.id !== socket.id) {
        previous.emit("revoked", { reason: "replaced by a newer adapter connection" });
        previous.disconnect(true);
      }
      this.adapterSockets.set(agentId, socket);
      log.info("adapter connected");

      /** Validates the payload, then runs the handler; every failure becomes a negative ack. */
      const handle = <S extends z.ZodType, R extends { ok: boolean; error?: string }>(
        schema: S,
        fn: (p: z.infer<S>) => Promise<R>,
        requireHello = true,
      ) => {
        return async (payload: unknown, ack?: (r: R | { ok: false; error: string }) => void) => {
          const reply = typeof ack === "function" ? ack : () => {};
          if (this.adapterSockets.get(agentId) !== socket) return reply({ ok: false, error: "stale connection" });
          if (requireHello && !socket.data.helloDone) return reply({ ok: false, error: "send hello first" });
          const parsed = schema.safeParse(payload);
          if (!parsed.success) {
            log.warn({ issues: parsed.error.issues.slice(0, 5) }, "malformed adapter payload");
            return reply({ ok: false, error: "malformed payload" });
          }
          try {
            reply(await fn(parsed.data));
          } catch (err) {
            log.error({ err }, "adapter event failed");
            reply({ ok: false, error: "server error" });
          }
        };
      };

      socket.on(
        "hello",
        handle(
          AdapterHello,
          async (hello) => {
            socket.data.helloDone = true;
            await adapterHello(ctx, agentId, hello);
            const a = await authenticateAgent(ctx, socket.handshake.auth?.token);
            return { ok: true, agent: a ? { id: a.id, handle: a.handle, projectId: a.projectId } : undefined };
          },
          false,
        ) as never,
      );
      socket.on(
        "heartbeat",
        handle(AdapterHeartbeat, async (hb) => {
          await adapterHeartbeat(ctx, agentId, hb);
          return { ok: true };
        }) as never,
      );
      socket.on("dispatch:accept", handle(DispatchAck, (p) => acceptDispatch(ctx, agentId, p.dispatchId)) as never);
      socket.on("dispatch:reject", handle(DispatchReject, (p) => rejectDispatch(ctx, agentId, p.dispatchId, p.reason)) as never);
      socket.on("run:event", handle(RunEvent, (p) => recordRunEvent(ctx, agentId, p)) as never);
      socket.on("run:complete", handle(RunComplete, (p) => completeDispatch(ctx, agentId, p)) as never);
      socket.on("approval:request", handle(ApprovalRequest, (p) => requestApproval(ctx, agentId, p)) as never);

      socket.on("disconnect", (reason) => {
        log.info({ reason }, "adapter disconnected");
        if (this.adapterSockets.get(agentId) === socket) {
          this.adapterSockets.delete(agentId);
          void adapterDisconnected(ctx, agentId).catch((err) => log.error({ err }, "disconnect bookkeeping failed"));
        }
      });
    });
  }
}
