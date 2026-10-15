import { execFile } from "node:child_process";
import type { GitInfo } from "@relayroom/protocol";

/**
 * Read-only git helpers. Every command runs with optional locks disabled so `git status` does not
 * even refresh the index, and none of them write to the working tree, index or refs.
 */
function git(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-optional-locks", "-c", "core.quotepath=off", ...args],
      {
        cwd,
        maxBuffer,
        windowsHide: true,
        timeout: 20_000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (err, stdout) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: stdout ?? "" });
      },
    );
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function headCommit(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** Parses `git status --porcelain=v1 -z --branch`. */
export function parseStatus(out: string): Pick<GitInfo, "branch" | "upstream" | "ahead" | "behind" | "changedFiles"> {
  const entries = out.split("\0").filter(Boolean);
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  const changedFiles: GitInfo["changedFiles"] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.startsWith("## ")) {
      const head = e.slice(3);
      const m = /^(.*?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head);
      if (m) {
        branch = m[1]!.startsWith("No commits yet on ") ? m[1]!.slice(18) : m[1] === "HEAD (no branch)" ? null : m[1]!;
        upstream = m[2] ?? null;
        if (m[3]) {
          ahead = Number(/ahead (\d+)/.exec(m[3])?.[1] ?? 0);
          behind = Number(/behind (\d+)/.exec(m[3])?.[1] ?? 0);
        } else if (upstream) {
          ahead = 0;
          behind = 0;
        }
      }
      continue;
    }
    const status = e.slice(0, 2).trim() || e.slice(0, 2);
    const file = e.slice(3);
    // Renames/copies are followed by the original path as a separate entry.
    if (status.startsWith("R") || status.startsWith("C")) i++;
    if (changedFiles.length < 500) changedFiles.push({ path: file, status });
  }
  return { branch, upstream, ahead, behind, changedFiles };
}

export async function collectGitInfo(cwd: string): Promise<GitInfo | null> {
  if (!(await isGitRepo(cwd))) return null;
  const [status, head] = await Promise.all([git(cwd, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=normal"]), headCommit(cwd)]);
  const parsed = parseStatus(status.stdout);
  return {
    isRepo: true,
    ...parsed,
    head,
    dirty: parsed.changedFiles.length > 0,
    collectedAt: new Date().toISOString(),
  };
}

/** `git diff <base>` (committed + uncommitted tracked changes since base), truncated. */
export async function diffSince(cwd: string, base: string | null, maxBytes = 150_000): Promise<{ diff: string | null; truncated: boolean }> {
  const args = base ? ["diff", "--no-color", "--no-ext-diff", base] : ["diff", "--no-color", "--no-ext-diff", "HEAD"];
  const r = await git(cwd, args, 32 * 1024 * 1024);
  if (r.code !== 0) return { diff: null, truncated: false };
  if (!r.stdout) return { diff: null, truncated: false };
  if (Buffer.byteLength(r.stdout) <= maxBytes) return { diff: r.stdout, truncated: false };
  return { diff: Buffer.from(r.stdout).subarray(0, maxBytes).toString("utf8"), truncated: true };
}

/** Is `commit` present locally and an ancestor of HEAD? Detects work starting from a stale base. */
export async function checkBase(cwd: string, commit: string): Promise<{ expectedCommit: string; present: boolean; isAncestorOfHead: boolean }> {
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) return { expectedCommit: commit, present: false, isAncestorOfHead: false };
  const present = (await git(cwd, ["cat-file", "-e", `${commit}^{commit}`])).code === 0;
  const isAncestorOfHead = present && (await git(cwd, ["merge-base", "--is-ancestor", commit, "HEAD"])).code === 0;
  return { expectedCommit: commit, present, isAncestorOfHead };
}
