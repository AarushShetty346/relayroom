import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export class PathError extends Error {}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** True if `child` is `root` or inside it. Both must already be absolute and real (symlinks resolved). */
export function isWithin(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel) && !samePath(rel.split(path.sep)[0]!, "..");
}

/**
 * Validates the directory a user registers for an agent. Resolves symlinks, requires an existing
 * directory, and refuses filesystem roots and the home directory itself (too broad to confine an agent).
 */
export function validateProjectDir(dir: string): string {
  if (!dir || typeof dir !== "string") throw new PathError("projectDir is required");
  if (!path.isAbsolute(dir)) throw new PathError("projectDir must be an absolute path");
  let real: string;
  try {
    real = realpathSync.native(dir);
  } catch {
    throw new PathError("projectDir does not exist");
  }
  if (!statSync(real).isDirectory()) throw new PathError("projectDir is not a directory");
  if (samePath(path.parse(real).root, real)) throw new PathError("projectDir cannot be a filesystem root");
  let home: string | null = null;
  try {
    home = realpathSync.native(homedir());
  } catch {
    home = null;
  }
  if (home && samePath(home, real)) throw new PathError("projectDir cannot be your home directory");
  return real;
}

/**
 * Resolves a relative path inside `root`, rejecting `..` traversal, absolute paths and symlinks that
 * point outside. For paths that do not exist yet, the nearest existing ancestor is checked.
 */
export function resolveInside(root: string, rel: string): string {
  if (rel.includes("\0")) throw new PathError("invalid path");
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith("\\\\")) throw new PathError("absolute paths are not allowed");
  const candidate = path.resolve(root, rel);
  if (!isWithin(root, candidate)) throw new PathError("path escapes the project directory");
  // Walk up to the nearest existing ancestor and check its real location.
  let probe = candidate;
  for (;;) {
    try {
      const real = realpathSync.native(probe);
      if (!isWithin(root, real)) throw new PathError("path escapes the project directory via a symlink");
      break;
    } catch (err) {
      if (err instanceof PathError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) throw new PathError("path cannot be resolved");
      probe = parent;
    }
  }
  return candidate;
}

/** For display in the shared room: project-relative paths only, never absolute local paths. */
export function displayPath(root: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  if (isWithin(root, abs)) return path.relative(root, abs).split(path.sep).join("/") || ".";
  return `[outside project]/${path.basename(abs)}`;
}
