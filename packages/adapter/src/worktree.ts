import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isWithin } from "./paths.js";

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, windowsHide: true, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) =>
      resolve({ code: err ? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "" }),
    );
  });
}

/**
 * Gives a task its own worktree and branch (relayroom/task-<id>) under <project>/.relayroom/worktrees,
 * so concurrent agents never write into each other's working tree. Additive only: it creates a branch
 * and a worktree, never resets, deletes or checks out over existing work. Reuses the worktree on later runs.
 */
export async function ensureTaskWorktree(projectDir: string, taskId: string): Promise<{ dir: string; branch: string; created: boolean }> {
  const short = taskId.replace(/[^a-f0-9]/gi, "").slice(0, 8);
  if (short.length < 8) throw new Error("invalid task id");
  const branch = `relayroom/task-${short}`;
  const root = path.join(projectDir, ".relayroom", "worktrees");
  const dir = path.join(root, `task-${short}`);
  if (existsSync(dir)) {
    const real = realpathSync.native(dir);
    if (!isWithin(projectDir, real)) throw new Error("worktree path escapes the project directory");
    const top = await git(real, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) throw new Error("existing worktree directory is not a git worktree");
    return { dir: real, branch, created: false };
  }
  mkdirSync(root, { recursive: true });
  excludeLocally(projectDir);
  const exists = (await git(projectDir, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).code === 0;
  const r = exists
    ? await git(projectDir, ["worktree", "add", dir, branch])
    : await git(projectDir, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim().slice(0, 500)}`);
  return { dir: realpathSync.native(dir), branch, created: true };
}

/** Keeps .relayroom/ out of `git status` using the repo-local exclude file (never committed). */
function excludeLocally(projectDir: string): void {
  const gitDir = path.join(projectDir, ".git");
  if (!existsSync(gitDir)) return;
  const info = path.join(gitDir, "info");
  const file = path.join(info, "exclude");
  try {
    mkdirSync(info, { recursive: true });
    const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!cur.split(/\r?\n/).includes(".relayroom/")) appendFileSync(file, `${cur.endsWith("\n") || !cur ? "" : "\n"}.relayroom/\n`);
  } catch {
    // Not fatal: the directory would just show up as untracked.
  }
}
