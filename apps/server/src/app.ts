import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import type { Config } from "./config.js";
import type { DbHandle } from "./db/client.js";
import { HttpError } from "./lib/errors.js";
import { registerRoutes } from "./routes/index.js";
import { SocketHub } from "./realtime/hub.js";
import type { Ctx } from "./services/ctx.js";
import { resetAgentConnections } from "./services/agents.js";
import { sweep } from "./services/dispatch.js";

export interface RelayRoomServer {
  app: FastifyInstance;
  ctx: Ctx;
  hub: SocketHub;
  close(): Promise<void>;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const CSRF_HEADER = "x-relayroom-csrf";

export async function buildServer(config: Config, dbh: DbHandle): Promise<RelayRoomServer> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Never log credentials.
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          'res.headers["set-cookie"]',
          "*.password",
          "*.token",
          "*.code",
        ],
        censor: "[redacted]",
      },
    },
    bodyLimit: 1_000_000,
    trustProxy: true,
  });

  const hub = new SocketHub();
  const ctx: Ctx = { db: dbh.db, hub, log: app.log, config };

  await app.register(cookie);
  await app.register(cors, { origin: config.webOrigins, credentials: true });

  // CSRF: browsers cannot attach a custom header cross-site without a CORS preflight we reject.
  app.addHook("onRequest", async (req, reply) => {
    if (MUTATING.has(req.method) && req.url.startsWith("/api/") && req.headers[CSRF_HEADER] !== "1") {
      return reply.code(403).send({ error: "forbidden", message: `Missing ${CSRF_HEADER} header` });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "bad_request", message: (err as Error).message });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal", message: "Internal server error" });
  });

  app.get("/api/health", async () => ({ ok: true }));
  registerRoutes(app, ctx);

  if (config.webDist) {
    const fastifyStatic = (await import("@fastify/static")).default;
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/socket.io/")) return reply.code(404).send({ error: "not_found" });
      return reply.sendFile("index.html");
    });
  }

  await app.ready();
  hub.attach(app.server, ctx);
  await resetAgentConnections(ctx);

  const timer = setInterval(() => {
    sweep(ctx).catch((err) => app.log.error({ err }, "sweep failed"));
  }, config.sweepIntervalMs);
  timer.unref();

  return {
    app,
    ctx,
    hub,
    async close() {
      clearInterval(timer);
      await hub.close();
      await app.close();
    },
  };
}
