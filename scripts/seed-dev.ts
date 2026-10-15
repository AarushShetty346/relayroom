/**
 * Local development seed: two test accounts (alice, bob), a shared "Demo" project, and two registered
 * agents (@claude, @codex). Talks to a running server over HTTP, like a browser would.
 *
 *   SEED_PASSWORD=<10+ chars> npm run seed
 *
 * The password comes from the environment (or .env), never from this file. Agent tokens are written to
 * .relayroom/dev-<handle>.token (gitignored) for use with the adapter's tokenFile option.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const base = process.env.RELAYROOM_URL ?? "http://127.0.0.1:4000";
const password = process.env.SEED_PASSWORD;
if (!password || password.length < 10) {
  console.error("Set SEED_PASSWORD (10+ characters) in the environment or .env");
  process.exit(2);
}

class Session {
  cookie = "";
  async call(method: string, p: string, body?: unknown) {
    const res = await fetch(base + p, {
      method,
      headers: { "x-relayroom-csrf": "1", "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) if (c.startsWith("rr_session=")) this.cookie = c.split(";")[0]!;
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }
  async signin(username: string, displayName: string) {
    let r = await this.call("POST", "/api/auth/login", { username, password });
    if (r.status === 401) r = await this.call("POST", "/api/auth/signup", { username, displayName, password });
    if (r.status >= 300) throw new Error(`${username}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.user as { id: string };
  }
}

const alice = new Session();
const bob = new Session();
await alice.signin("alice", "Alice");
await bob.signin("bob", "Bob");

const projects = (await alice.call("GET", "/api/projects")).body.projects as { id: string; name: string }[];
let project = projects.find((p) => p.name === "Demo");
if (!project) {
  project = (await alice.call("POST", "/api/projects", { name: "Demo", description: "RelayRoom local demo" })).body.project;
  const invite = (await alice.call("POST", `/api/projects/${project!.id}/invites`, { maxUses: 1 })).body.invite;
  await bob.call("POST", "/api/invites/accept", { code: invite.code });
}

const outDir = path.resolve(".relayroom");
mkdirSync(outDir, { recursive: true });
const agents = (await alice.call("GET", `/api/projects/${project!.id}/agents`)).body.agents as { handle: string; revokedAt: string | null }[];
for (const [who, handle, displayName, provider] of [
  [alice, "claude", "Claude", "claude-code"],
  [bob, "codex", "Codex", "codex"],
] as const) {
  if (agents.some((a) => a.handle === handle && !a.revokedAt)) continue;
  const r = await who.call("POST", `/api/projects/${project!.id}/agents`, { handle, displayName, provider });
  if (r.status !== 201) throw new Error(`agent ${handle}: ${JSON.stringify(r.body)}`);
  writeFileSync(path.join(outDir, `dev-${handle}.token`), r.body.token + "\n", { mode: 0o600 });
}
console.log(`Seeded project "Demo" (${project!.id}) with users alice, bob and agents @claude, @codex.`);
console.log(`Agent tokens (if newly created) are in ${outDir}. Sign in at http://localhost:5173 as alice or bob.`);
