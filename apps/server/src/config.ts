import path from "node:path";
import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default("127.0.0.1"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Serve the built web UI from this directory (production). */
  WEB_DIST: z.string().optional(),
  /** `invite`: accounts can only be created with a project invite code (use this whenever the server is reachable from outside). */
  SIGNUP_MODE: z.enum(["open", "invite"]).default("open"),
  /** Sign-in/sign-up attempts allowed per client IP per minute. 0 disables the limit. */
  AUTH_RATE_LIMIT: z.coerce.number().int().min(0).default(20),
});

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  /** Allowed browser origins. */
  webOrigins: string[];
  cookieSecure: boolean;
  logLevel: z.infer<typeof Env>["LOG_LEVEL"];
  webDist: string | undefined;
  sessionTtlMs: number;
  /** How long a running dispatch survives without its adapter before it is marked interrupted. */
  orphanGraceMs: number;
  sweepIntervalMs: number;
  /** Default "open". */
  signupMode?: "open" | "invite";
  /** Auth attempts per IP per minute; undefined or 0 = no limit. */
  authRateLimitPerMinute?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    host: e.HOST,
    webOrigins: e.WEB_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
    cookieSecure: e.COOKIE_SECURE,
    logLevel: e.LOG_LEVEL,
    webDist: e.WEB_DIST ? path.resolve(e.WEB_DIST) : undefined,
    sessionTtlMs: 14 * 24 * 3600_000,
    orphanGraceMs: 90_000,
    sweepIntervalMs: 15_000,
    signupMode: e.SIGNUP_MODE,
    authRateLimitPerMinute: e.AUTH_RATE_LIMIT,
  };
}
