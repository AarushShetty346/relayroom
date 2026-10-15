import { loadConfig } from "./config.js";
import { openDb, runMigrations } from "./db/client.js";
import { buildServer } from "./app.js";

const config = loadConfig();
const dbh = await openDb(config.databaseUrl);
await runMigrations(dbh);
const server = await buildServer(config, dbh);
await server.app.listen({ port: config.port, host: config.host });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  server.app.log.info({ signal }, "shutting down");
  await server.close();
  await dbh.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
