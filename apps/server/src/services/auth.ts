import { and, eq, gt, lt } from "drizzle-orm";
import type { UserDTO } from "@relayroom/protocol";
import type { Ctx } from "./ctx.js";
import { sessions, users } from "../db/schema.js";
import { hashPassword, randomToken, sha256, verifyPassword } from "../lib/crypto.js";
import { conflict, unauthorized } from "../lib/errors.js";

// Used to keep login timing similar for unknown usernames.
let dummyHash: Promise<string> | null = null;

export function userDTO(u: typeof users.$inferSelect): UserDTO {
  return { id: u.id, username: u.username, displayName: u.displayName };
}

export async function signup(
  ctx: Ctx,
  input: { username: string; displayName: string; password: string },
): Promise<UserDTO> {
  const passwordHash = await hashPassword(input.password);
  const rows = await ctx.db
    .insert(users)
    .values({ username: input.username, displayName: input.displayName, passwordHash })
    .onConflictDoNothing({ target: users.username })
    .returning();
  const u = rows[0];
  if (!u) throw conflict("That username is taken");
  return userDTO(u);
}

export async function login(ctx: Ctx, input: { username: string; password: string }): Promise<UserDTO> {
  const [u] = await ctx.db.select().from(users).where(eq(users.username, input.username.toLowerCase()));
  if (!u) {
    dummyHash ??= hashPassword("not-a-real-password");
    await verifyPassword(input.password, await dummyHash);
    throw unauthorized("Invalid username or password");
  }
  if (!(await verifyPassword(input.password, u.passwordHash))) throw unauthorized("Invalid username or password");
  return userDTO(u);
}

export async function createSession(ctx: Ctx, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ctx.config.sessionTtlMs);
  await ctx.db.insert(sessions).values({ userId, tokenHash: sha256(token), expiresAt });
  // Opportunistic cleanup of expired sessions.
  await ctx.db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return { token, expiresAt };
}

export async function userForSessionToken(ctx: Ctx, token: string | undefined): Promise<UserDTO | null> {
  if (!token || token.length > 200) return null;
  const rows = await ctx.db
    .select({ u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())));
  return rows[0] ? userDTO(rows[0].u) : null;
}

export async function deleteSession(ctx: Ctx, token: string | undefined): Promise<void> {
  if (!token) return;
  await ctx.db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}
