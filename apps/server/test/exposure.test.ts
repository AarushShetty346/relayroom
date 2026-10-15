/**
 * Settings for running the server where strangers can reach it: invite-only sign-up and per-IP limits
 * on sign-in/sign-up.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startTestServer, type TestServer } from "./helpers.js";

describe("invite-only sign-up", () => {
  let ts: TestServer;
  let owner: Client;
  let projectId: string;
  beforeAll(async () => {
    ts = await startTestServer({ signupMode: "invite" });
    // The owner is created out of band (like `npm run create-user`), then signs in.
    const { users } = await import("../src/db/schema.js");
    const { hashPassword } = await import("../src/lib/crypto.js");
    await ts.dbh.db.insert(users).values({ username: "owner", displayName: "Owner", passwordHash: await hashPassword("owner password 123") });
    owner = new Client(ts.baseUrl);
    expect((await owner.post("/api/auth/login", { username: "owner", password: "owner password 123" })).status).toBe(200);
    projectId = (await owner.post("/api/projects", { name: "Team" })).body.project.id;
  });
  afterAll(async () => {
    await ts.stop();
  });

  const signup = (inviteCode?: string, username = "stranger") =>
    new Client(ts.baseUrl).post("/api/auth/signup", { username, displayName: "S", password: "a long enough password", ...(inviteCode ? { inviteCode } : {}) });

  it("tells the UI it is invite-only", async () => {
    expect((await new Client(ts.baseUrl).get("/api/server-info")).body).toEqual({ signupMode: "invite" });
  });

  it("refuses sign-up without a code and creates nothing", async () => {
    const r = await signup();
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/invite-only/);
    expect((await new Client(ts.baseUrl).post("/api/auth/login", { username: "stranger", password: "a long enough password" })).status).toBe(401);
  });

  it("refuses an invalid code without creating the account", async () => {
    expect((await signup("rr_inv_this-is-not-a-real-code")).status).toBe(400);
    expect((await new Client(ts.baseUrl).post("/api/auth/login", { username: "stranger", password: "a long enough password" })).status).toBe(401);
  });

  it("a valid code creates the account inside the project, once", async () => {
    const code = (await owner.post(`/api/projects/${projectId}/invites`, { maxUses: 1 })).body.invite.code;
    const ok = await signup(code, "harsh");
    expect(ok.status).toBe(201);
    const members = (await owner.get(`/api/projects/${projectId}`)).body.members.map((m: { username: string }) => m.username);
    expect(members).toContain("harsh");
    // Used up: the next person cannot reuse it, and their account is not created.
    expect((await signup(code, "anuj")).status).toBe(400);
    expect((await new Client(ts.baseUrl).post("/api/auth/login", { username: "anuj", password: "a long enough password" })).status).toBe(401);
  });

  it("a revoked or expired invite cannot create accounts", async () => {
    const inv = (await owner.post(`/api/projects/${projectId}/invites`, { maxUses: 5 })).body.invite;
    await owner.del(`/api/projects/${projectId}/invites/${inv.id}`);
    expect((await signup(inv.code, "late")).status).toBe(400);
  });
});

describe("sign-in rate limit", () => {
  let ts: TestServer;
  beforeAll(async () => {
    ts = await startTestServer({ authRateLimitPerMinute: 5 });
  });
  afterAll(async () => {
    await ts.stop();
  });

  it("blocks password guessing after the limit", async () => {
    const c = new Client(ts.baseUrl);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await c.post("/api/auth/login", { username: "nobody", password: `guess-${i}` })).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    // Other routes are not limited.
    expect((await c.get("/api/server-info")).status).toBe(200);
  });
});
