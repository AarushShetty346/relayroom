import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { InviteDTO, MemberDTO, ProjectDTO, UserDTO } from "@relayroom/protocol";
import type { Ctx } from "./ctx.js";
import type { DbOrTx } from "../db/client.js";
import { invites, projectMembers, projects, users } from "../db/schema.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { postSystemMessage } from "./message-store.js";
import { Outbox } from "./ctx.js";

export type Role = "owner" | "member";

/**
 * Every project-scoped operation goes through this. Non-members get 404 so project ids cannot be
 * probed.
 */
export async function requireMember(db: DbOrTx, projectId: string, userId: string): Promise<Role> {
  const [m] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  if (!m) throw notFound("Project not found");
  return m.role;
}

export async function requireOwner(db: DbOrTx, projectId: string, userId: string): Promise<void> {
  if ((await requireMember(db, projectId, userId)) !== "owner") throw forbidden("Only the project owner can do that");
}

function projectDTO(p: typeof projects.$inferSelect, role: Role): ProjectDTO {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    ownerId: p.ownerId,
    role,
    createdAt: p.createdAt.toISOString(),
  };
}

export async function createProject(ctx: Ctx, user: UserDTO, input: { name: string; description: string }) {
  return ctx.db.transaction(async (tx) => {
    const [p] = await tx.insert(projects).values({ name: input.name, description: input.description, ownerId: user.id }).returning();
    await tx.insert(projectMembers).values({ projectId: p!.id, userId: user.id, role: "owner" });
    return projectDTO(p!, "owner");
  });
}

export async function listProjects(ctx: Ctx, user: UserDTO): Promise<ProjectDTO[]> {
  const rows = await ctx.db
    .select({ p: projects, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.userId, user.id))
    .orderBy(desc(projects.createdAt));
  return rows.map((r) => projectDTO(r.p, r.role));
}

export async function getProject(ctx: Ctx, user: UserDTO, projectId: string): Promise<ProjectDTO> {
  const role = await requireMember(ctx.db, projectId, user.id);
  const [p] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
  if (!p) throw notFound("Project not found");
  return projectDTO(p, role);
}

export async function listMembers(ctx: Ctx, user: UserDTO, projectId: string): Promise<MemberDTO[]> {
  await requireMember(ctx.db, projectId, user.id);
  const online = ctx.hub.onlineUserIds(projectId);
  const rows = await ctx.db
    .select({ u: users, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(projectMembers.joinedAt);
  return rows.map((r) => ({
    userId: r.u.id,
    username: r.u.username,
    displayName: r.u.displayName,
    role: r.role,
    online: online.has(r.u.id),
  }));
}

function inviteDTO(i: typeof invites.$inferSelect, code?: string): InviteDTO {
  return {
    id: i.id,
    ...(code ? { code } : {}),
    expiresAt: i.expiresAt.toISOString(),
    maxUses: i.maxUses,
    uses: i.uses,
    revokedAt: i.revokedAt?.toISOString() ?? null,
  };
}

export async function createInvite(
  ctx: Ctx,
  user: UserDTO,
  projectId: string,
  input: { expiresInHours: number; maxUses: number },
): Promise<InviteDTO> {
  await requireOwner(ctx.db, projectId, user.id);
  const code = "rr_inv_" + randomToken(24);
  const [i] = await ctx.db
    .insert(invites)
    .values({
      projectId,
      codeHash: sha256(code),
      createdBy: user.id,
      expiresAt: new Date(Date.now() + input.expiresInHours * 3600_000),
      maxUses: input.maxUses,
    })
    .returning();
  return inviteDTO(i!, code);
}

export async function listInvites(ctx: Ctx, user: UserDTO, projectId: string): Promise<InviteDTO[]> {
  await requireOwner(ctx.db, projectId, user.id);
  const rows = await ctx.db.select().from(invites).where(eq(invites.projectId, projectId)).orderBy(desc(invites.createdAt));
  return rows.map((i) => inviteDTO(i));
}

export async function revokeInvite(ctx: Ctx, user: UserDTO, projectId: string, inviteId: string): Promise<void> {
  await requireOwner(ctx.db, projectId, user.id);
  await ctx.db
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(invites.id, inviteId), eq(invites.projectId, projectId)));
}

export async function acceptInvite(ctx: Ctx, user: UserDTO, code: string): Promise<ProjectDTO> {
  const outbox = new Outbox();
  const result = await ctx.db.transaction((tx) => joinWithInvite(tx, outbox, user, code));
  await outbox.flush(ctx);
  return result;
}

/** Consumes one use of a valid invite and adds the user to its project, inside the caller's transaction. */
export async function joinWithInvite(tx: DbOrTx, outbox: Outbox, user: UserDTO, code: string): Promise<ProjectDTO> {
  // Atomically consume one use of a valid invite.
  const [inv] = await tx
    .update(invites)
    .set({ uses: sql`${invites.uses} + 1` })
    .where(
      and(
        eq(invites.codeHash, sha256(code)),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, new Date()),
        lt(invites.uses, invites.maxUses),
      ),
    )
    .returning();
  if (!inv) throw badRequest("This invitation is invalid, expired, or already used");
  const inserted = await tx
    .insert(projectMembers)
    .values({ projectId: inv.projectId, userId: user.id, role: "member" })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    // Already a member: do not burn the invite.
    await tx.update(invites).set({ uses: sql`${invites.uses} - 1` }).where(eq(invites.id, inv.id));
  } else {
    await postSystemMessage(tx, outbox, inv.projectId, `${user.displayName} (@${user.username}) joined the project.`);
  }
  const [p] = await tx.select().from(projects).where(eq(projects.id, inv.projectId));
  const role = await requireMember(tx, inv.projectId, user.id);
  return projectDTO(p!, role);
}
