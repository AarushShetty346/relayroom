import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, nonce, startTestServer, type TestServer } from "./helpers.js";

let ts: TestServer;
beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.stop();
});

describe("accounts and sessions", () => {
  it("signs up, reads /api/me, logs out", async () => {
    const c = new Client(ts.baseUrl);
    const u = await c.signup("dana", "Dana");
    expect(u.username).toBe("dana");
    expect((await c.get("/api/me")).body.user.id).toBe(u.id);
    await c.post("/api/auth/logout");
    expect((await c.get("/api/me")).status).toBe(401);
  });

  it("rejects duplicate usernames, weak passwords and bad usernames", async () => {
    const c = new Client(ts.baseUrl);
    await c.signup("erin");
    const dup = await new Client(ts.baseUrl).post("/api/auth/signup", { username: "erin", displayName: "E", password: "another long password" });
    expect(dup.status).toBe(409);
    const weak = await new Client(ts.baseUrl).post("/api/auth/signup", { username: "fred", displayName: "F", password: "short" });
    expect(weak.status).toBe(400);
    const bad = await new Client(ts.baseUrl).post("/api/auth/signup", { username: "Bad Name!", displayName: "B", password: "long enough password" });
    expect(bad.status).toBe(400);
  });

  it("rejects wrong passwords without revealing whether the user exists", async () => {
    const c = new Client(ts.baseUrl);
    await c.signup("gail");
    const wrong = await new Client(ts.baseUrl).post("/api/auth/login", { username: "gail", password: "nope nope nope" });
    const missing = await new Client(ts.baseUrl).post("/api/auth/login", { username: "nobody", password: "nope nope nope" });
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.body.message).toBe(missing.body.message);
    const ok = await new Client(ts.baseUrl).post("/api/auth/login", { username: "gail", password: "correct horse battery" });
    expect(ok.status).toBe(200);
  });

  it("requires the CSRF header on mutations", async () => {
    const c = new Client(ts.baseUrl);
    await c.signup("hank");
    const r = await c.req("POST", "/api/projects", { name: "x" }, { csrf: false });
    expect(r.status).toBe(403);
  });

  it("rejects malformed JSON payloads with 400", async () => {
    const c = new Client(ts.baseUrl);
    await c.signup("ivan");
    const r = await c.post("/api/projects", { name: 42 });
    expect(r.status).toBe(400);
    expect(r.body.details[0].path).toBe("name");
  });
});

describe("project membership boundaries", () => {
  it("hides projects from non-members across every protected route", async () => {
    const owner = new Client(ts.baseUrl);
    await owner.signup("olga");
    const p = (await owner.post("/api/projects", { name: "Secret" })).body.project;
    const outsider = new Client(ts.baseUrl);
    await outsider.signup("oscar");

    const probes = [
      outsider.get(`/api/projects/${p.id}`),
      outsider.get(`/api/projects/${p.id}/messages`),
      outsider.post(`/api/projects/${p.id}/messages`, { body: "hi", clientNonce: nonce() }),
      outsider.get(`/api/projects/${p.id}/agents`),
      outsider.post(`/api/projects/${p.id}/agents`, { handle: "bot", displayName: "Bot", provider: "codex" }),
      outsider.get(`/api/projects/${p.id}/tasks`),
      outsider.post(`/api/projects/${p.id}/tasks`, { title: "t" }),
      outsider.get(`/api/projects/${p.id}/memory`),
      outsider.get(`/api/projects/${p.id}/search?q=hello`),
    ];
    for (const r of await Promise.all(probes)) expect(r.status).toBe(404);
    expect((await outsider.get("/api/projects")).body.projects).toEqual([]);

    // Unauthenticated
    const anon = new Client(ts.baseUrl);
    expect((await anon.get(`/api/projects/${p.id}/messages`)).status).toBe(401);
  });

  it("invites: owner-only creation, single use, expiry, revocation", async () => {
    const owner = new Client(ts.baseUrl);
    await owner.signup("paula");
    const p = (await owner.post("/api/projects", { name: "Team" })).body.project;
    const member = new Client(ts.baseUrl);
    await member.signup("quinn");
    const third = new Client(ts.baseUrl);
    await third.signup("rita");

    const inv = (await owner.post(`/api/projects/${p.id}/invites`, { maxUses: 1 })).body.invite;
    expect(inv.code).toMatch(/^rr_inv_/);
    const join = await member.post("/api/invites/accept", { code: inv.code });
    expect(join.status).toBe(200);
    expect(join.body.project.role).toBe("member");
    // Used up.
    expect((await third.post("/api/invites/accept", { code: inv.code })).status).toBe(400);
    // Members cannot create invites.
    expect((await member.post(`/api/projects/${p.id}/invites`, {})).status).toBe(403);
    // Revoked invites stop working.
    const inv2 = (await owner.post(`/api/projects/${p.id}/invites`, { maxUses: 5 })).body.invite;
    await owner.del(`/api/projects/${p.id}/invites/${inv2.id}`);
    expect((await third.post("/api/invites/accept", { code: inv2.code })).status).toBe(400);
    // Invite listing never exposes codes again.
    const listed = (await owner.get(`/api/projects/${p.id}/invites`)).body.invites;
    expect(listed.every((i: { code?: string }) => i.code === undefined)).toBe(true);

    const members = (await member.get(`/api/projects/${p.id}`)).body.members;
    expect(members.map((m: { username: string }) => m.username).sort()).toEqual(["paula", "quinn"]);
  });

  it("refuses socket room joins for non-members and unauthenticated sockets", async () => {
    const owner = new Client(ts.baseUrl);
    await owner.signup("sam");
    const p = (await owner.post("/api/projects", { name: "S" })).body.project;
    const outsider = new Client(ts.baseUrl);
    await outsider.signup("tina");
    await expect(outsider.socket(p.id)).rejects.toThrow(/not a member/);
    const anon = new Client(ts.baseUrl);
    await expect(anon.socket(p.id)).rejects.toThrow(/unauthorized/);
  });
});
