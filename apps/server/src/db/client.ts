import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export interface DbHandle {
  db: Db;
  kind: "postgres" | "pglite";
  close(): Promise<void>;
}

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Opens the database. `pglite:memory` (or `pglite:<dir>`) starts an in-process PGlite instance,
 * used by the test suite when no real Postgres is configured. Everything else is a Postgres URL.
 */
export async function openDb(url: string): Promise<DbHandle> {
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const target = url.slice("pglite:".length);
    const client = target === "memory" ? new PGlite() : new PGlite(target);
    const db = drizzle(client, { schema }) as unknown as Db;
    return { db, kind: "pglite", close: () => client.close() };
  }
  const pg = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new pg.default.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 10_000 });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return { db, kind: "postgres", close: () => pool.end() };
}

export async function runMigrations(handle: DbHandle): Promise<void> {
  if (handle.kind === "pglite") {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(handle.db as never, { migrationsFolder: MIGRATIONS_DIR });
  } else {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(handle.db as never, { migrationsFolder: MIGRATIONS_DIR });
  }
}
