/**
 * Creates an account directly in the database. For invite-only servers this is how the first person
 * (the owner) gets in; everyone else joins with an invite code from the app.
 *
 *   npm run create-user -- <username> "<Display Name>"
 *
 * Run it on the server machine. A random password is generated and printed once; nothing is logged.
 */
import { randomBytes } from "node:crypto";
import { Handle } from "@relayroom/protocol";
import { openDb, runMigrations } from "../apps/server/src/db/client.js";
import { users } from "../apps/server/src/db/schema.js";
import { hashPassword } from "../apps/server/src/lib/crypto.js";

const [username, displayName] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (see .env)");
  process.exit(2);
}
if (!username || !displayName || !Handle.safeParse(username).success) {
  console.error('usage: npm run create-user -- <username> "<Display Name>"   (username: lowercase letters, digits, - or _)');
  process.exit(2);
}

const password = randomBytes(15).toString("base64url");
const dbh = await openDb(url);
try {
  await runMigrations(dbh);
  const rows = await dbh.db
    .insert(users)
    .values({ username, displayName, passwordHash: await hashPassword(password) })
    .onConflictDoNothing({ target: users.username })
    .returning({ id: users.id });
  if (!rows.length) {
    console.error(`The username "${username}" is already taken.`);
    process.exitCode = 1;
  } else {
    console.log(`Created @${username}. Password (shown only now, save it in your password manager):\n\n  ${password}\n`);
  }
} finally {
  await dbh.close();
}
