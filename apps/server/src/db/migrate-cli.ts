import { openDb, runMigrations } from "./client.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (copy .env.example to .env)");
  process.exit(1);
}
const handle = await openDb(url);
try {
  await runMigrations(handle);
  console.log("migrations applied");
} finally {
  await handle.close();
}
