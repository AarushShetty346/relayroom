import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AcceptInviteBody,
  AssignTaskBody,
  CreateAgentBody,
  CreateInviteBody,
  CreateMemoryBody,
  CreateProjectBody,
  CreateTaskBody,
  DecideApprovalBody,
  Id,
  LoginBody,
  SendMessageBody,
  SignupBody,
  TransitionTaskBody,
  UpdateMemoryBody,
  UpdateTaskBody,
  type UserDTO,
} from "@relayroom/protocol";
import { and, asc, eq } from "drizzle-orm";
import type { Ctx } from "../services/ctx.js";
import { badRequest, notFound, unauthorized } from "../lib/errors.js";
import { SESSION_COOKIE } from "../lib/cookies.js";
import * as auth from "../services/auth.js";
import * as projects from "../services/projects.js";
import * as messages from "../services/messages.js";
import * as agentsSvc from "../services/agents.js";
import * as dispatch from "../services/dispatch.js";
import * as tasksSvc from "../services/tasks.js";
import * as memory from "../services/memory.js";
import * as approvalsSvc from "../services/approvals.js";
import { dispatches, runEvents } from "../db/schema.js";
import { dispatchDTO } from "../services/serialize.js";
import { searchProject } from "../services/search.js";

declare module "fastify" {
  interface FastifyRequest {
    user: UserDTO | null;
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw badRequest(
      "Invalid request",
      r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}

const IdParam = z.object({ id: Id });
const PageQuery = z.object({
  before: z.string().max(20).optional(),
  after: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  taskId: Id.optional(),
});

export function registerRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (req) => {
    req.user = await auth.userForSessionToken(ctx, req.cookies[SESSION_COOKIE]);
  });

  const me = (req: FastifyRequest): UserDTO => {
    if (!req.user) throw unauthorized();
    return req.user;
  };
  const idOf = (req: FastifyRequest) => parse(IdParam, req.params).id;

  const setSession = (reply: FastifyReply, token: string, expiresAt: Date) =>
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: ctx.config.cookieSecure,
      path: "/",
      expires: expiresAt,
    });

  // ----- auth -----
  app.post("/api/auth/signup", async (req, reply) => {
    const body = parse(SignupBody, req.body);
    const user = await auth.signup(ctx, body);
    const s = await auth.createSession(ctx, user.id);
    setSession(reply, s.token, s.expiresAt);
    return reply.code(201).send({ user });
  });
  app.post("/api/auth/login", async (req, reply) => {
    const user = await auth.login(ctx, parse(LoginBody, req.body));
    const s = await auth.createSession(ctx, user.id);
    setSession(reply, s.token, s.expiresAt);
    return { user };
  });
  app.post("/api/auth/logout", async (req, reply) => {
    await auth.deleteSession(ctx, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
  app.get("/api/me", async (req) => ({ user: me(req) }));

  // ----- projects & membership -----
  app.get("/api/projects", async (req) => ({ projects: await projects.listProjects(ctx, me(req)) }));
  app.post("/api/projects", async (req, reply) => {
    const p = await projects.createProject(ctx, me(req), parse(CreateProjectBody, req.body));
    return reply.code(201).send({ project: p });
  });
  app.get("/api/projects/:id", async (req) => {
    const user = me(req);
    const id = idOf(req);
    return { project: await projects.getProject(ctx, user, id), members: await projects.listMembers(ctx, user, id) };
  });
  app.post("/api/projects/:id/invites", async (req, reply) => {
    const inv = await projects.createInvite(ctx, me(req), idOf(req), parse(CreateInviteBody, req.body));
    return reply.code(201).send({ invite: inv });
  });
  app.get("/api/projects/:id/invites", async (req) => ({ invites: await projects.listInvites(ctx, me(req), idOf(req)) }));
  app.delete("/api/projects/:id/invites/:inviteId", async (req) => {
    const p = parse(z.object({ id: Id, inviteId: Id }), req.params);
    await projects.revokeInvite(ctx, me(req), p.id, p.inviteId);
    return { ok: true };
  });
  app.post("/api/invites/accept", async (req) => ({
    project: await projects.acceptInvite(ctx, me(req), parse(AcceptInviteBody, req.body).code),
  }));

  // ----- messages -----
  app.get("/api/projects/:id/messages", async (req) =>
    messages.listMessages(ctx, me(req), idOf(req), parse(PageQuery, req.query)),
  );
  app.post("/api/projects/:id/messages", async (req, reply) => {
    const r = await messages.sendMessage(ctx, me(req), idOf(req), parse(SendMessageBody, req.body));
    return reply.code(r.needsConfirmation ? 409 : 201).send(r);
  });
  app.get("/api/projects/:id/search", async (req) => {
    const q = parse(z.object({ q: z.string().trim().min(2).max(200) }), req.query);
    return searchProject(ctx, me(req), idOf(req), q.q);
  });

  // ----- agents -----
  app.get("/api/projects/:id/agents", async (req) => ({ agents: await agentsSvc.listAgents(ctx, me(req), idOf(req)) }));
  app.post("/api/projects/:id/agents", async (req, reply) => {
    const r = await agentsSvc.createAgent(ctx, me(req), idOf(req), parse(CreateAgentBody, req.body));
    return reply.code(201).send(r);
  });
  app.post("/api/agents/:id/revoke", async (req) => {
    await agentsSvc.revokeAgent(ctx, me(req), idOf(req));
    return { ok: true };
  });
  app.post("/api/agents/:id/rotate-token", async (req) => agentsSvc.rotateAgentToken(ctx, me(req), idOf(req)));

  // ----- dispatches -----
  app.get("/api/projects/:id/dispatches", async (req) => {
    const user = me(req);
    const id = idOf(req);
    await projects.requireMember(ctx.db, id, user.id);
    const rows = await ctx.db.select().from(dispatches).where(eq(dispatches.projectId, id)).orderBy(asc(dispatches.createdAt));
    return { dispatches: rows.slice(-200).map(dispatchDTO) };
  });
  app.get("/api/dispatches/:id/events", async (req) => {
    const user = me(req);
    const id = idOf(req);
    const [d] = await ctx.db.select().from(dispatches).where(eq(dispatches.id, id));
    if (!d) throw notFound("Dispatch not found");
    await projects.requireMember(ctx.db, d.projectId, user.id);
    const ev = await ctx.db.select().from(runEvents).where(and(eq(runEvents.dispatchId, id))).orderBy(asc(runEvents.seq));
    return {
      dispatch: dispatchDTO(d),
      events: ev.map((e) => ({ dispatchId: id, seq: e.seq, type: e.type, text: e.text, createdAt: e.createdAt.toISOString() })),
    };
  });
  app.post("/api/dispatches/:id/cancel", async (req) => dispatch.cancelDispatch(ctx, me(req), idOf(req)));
  app.post("/api/dispatches/:id/retry", async (req, reply) => {
    const body = parse(z.object({ confirmConcurrent: z.boolean().default(false) }), req.body);
    const r = await dispatch.retryDispatch(ctx, me(req), idOf(req), body.confirmConcurrent);
    return reply.code("needsConfirmation" in r ? 409 : 201).send(r);
  });

  // ----- approvals (human-in-the-loop for agent actions outside the allowlist) -----
  app.get("/api/projects/:id/approvals", async (req) => ({ approvals: await approvalsSvc.listApprovals(ctx, me(req), idOf(req)) }));
  app.post("/api/approvals/:id/decide", async (req) =>
    approvalsSvc.decideApproval(ctx, me(req), idOf(req), parse(DecideApprovalBody, req.body)),
  );

  // ----- tasks -----
  app.get("/api/projects/:id/tasks", async (req) => ({ tasks: await tasksSvc.listTasks(ctx, me(req), idOf(req)) }));
  app.post("/api/projects/:id/tasks", async (req, reply) => {
    const t = await tasksSvc.createTask(ctx, me(req), idOf(req), parse(CreateTaskBody, req.body));
    return reply.code(201).send({ task: t });
  });
  app.get("/api/tasks/:id", async (req) => tasksSvc.getTaskDetail(ctx, me(req), idOf(req)));
  app.get("/api/projects/:id/handoffs", async (req) => ({ handoffs: await tasksSvc.recentHandoffs(ctx, me(req), idOf(req)) }));
  app.patch("/api/tasks/:id", async (req) => ({ task: await tasksSvc.updateTask(ctx, me(req), idOf(req), parse(UpdateTaskBody, req.body)) }));
  app.post("/api/tasks/:id/assign", async (req, reply) => {
    const r = await tasksSvc.assignTask(ctx, me(req), idOf(req), parse(AssignTaskBody, req.body));
    return reply.code(r.needsConfirmation ? 409 : 200).send(r);
  });
  app.post("/api/tasks/:id/transition", async (req) => ({
    task: await tasksSvc.transitionTask(ctx, me(req), idOf(req), parse(TransitionTaskBody, req.body)),
  }));

  // ----- memory -----
  app.get("/api/projects/:id/memory", async (req) => ({ entries: await memory.listMemory(ctx, me(req), idOf(req)) }));
  app.post("/api/projects/:id/memory", async (req, reply) => {
    const m = await memory.createMemory(ctx, me(req), idOf(req), parse(CreateMemoryBody, req.body));
    return reply.code(201).send({ entry: m });
  });
  app.patch("/api/memory/:id", async (req) => ({ entry: await memory.updateMemory(ctx, me(req), idOf(req), parse(UpdateMemoryBody, req.body)) }));
  app.delete("/api/memory/:id", async (req) => {
    await memory.deleteMemory(ctx, me(req), idOf(req));
    return { ok: true };
  });
}
