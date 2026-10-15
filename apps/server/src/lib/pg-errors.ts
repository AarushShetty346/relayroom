/** True for a Postgres unique_violation, whether or not the driver wrapped the error. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const pg = e as { code?: string; constraint?: string; message?: string };
    if (pg.code === "23505") {
      return !constraint || pg.constraint === constraint || (pg.message ?? "").includes(constraint);
    }
  }
  return false;
}
