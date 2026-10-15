/**
 * Runs the server for people outside this machine (behind an HTTPS tunnel or reverse proxy):
 * invite-only sign-up, secure cookies, the built web UI on the same origin, sign-in rate limits.
 *
 *   npm run build:web
 *   npm run serve:public -- https://<your-public-address>
 *
 * Settings come from .env (DATABASE_URL, …); the values below override it for public use.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicUrl = process.argv[2];
let origin: string;
try {
  const u = new URL(publicUrl ?? "");
  if (u.protocol !== "https:") throw new Error("must be https");
  origin = u.origin;
} catch {
  console.error("usage: npm run serve:public -- https://<your-public-address>   (must be https)");
  process.exit(2);
}
const webDist = path.join(root, "apps", "web", "dist");
if (!existsSync(path.join(webDist, "index.html"))) {
  console.error("Build the web UI first: npm run build:web");
  process.exit(2);
}

const env = {
  ...process.env,
  SIGNUP_MODE: "invite",
  COOKIE_SECURE: "true",
  WEB_ORIGIN: `${origin},http://localhost:4000`,
  WEB_DIST: webDist,
  HOST: "127.0.0.1",
  PORT: process.env.PORT ?? "4000",
  AUTH_RATE_LIMIT: process.env.AUTH_RATE_LIMIT ?? "20",
};
console.log(`Serving RelayRoom for ${origin} (invite-only sign-up, secure cookies). Local: http://localhost:${env.PORT}`);
const child = spawn(process.execPath, ["--import", "tsx", "--env-file-if-exists=.env", path.join("apps", "server", "src", "main.ts")], {
  cwd: root,
  env,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
