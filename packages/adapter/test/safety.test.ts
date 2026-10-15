import { removeTemp } from "./tmp.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { checkBase, collectGitInfo, diffSince, parseStatus } from "../src/git.js";
import { displayPath, PathError, resolveInside, validateProjectDir } from "../src/paths.js";
import { Redactor } from "../src/redact.js";
import { Journal } from "../src/journal.js";
import { childEnv } from "../src/runner.js";
import { ensureTaskWorktree } from "../src/worktree.js";

const tmpRoots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "rr-adapter-"));
  tmpRoots.push(d);
  return validateProjectDir(d);
}
afterAll(() => {
  for (const d of tmpRoots) removeTemp(d);
});

const gitc = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

function initRepo(): string {
  const dir = tmp();
  gitc(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  writeFileSync(path.join(dir, "b.txt"), "two\n");
  gitc(dir, "add", ".");
  gitc(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** Hash of every file (including .git internals) plus mtimes: detects any write. */
function snapshot(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(p).update(String(st.mtimeMs)).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

describe("repository path validation", () => {
  it("accepts a real directory and rejects missing, relative, file, root and home paths", () => {
    const d = tmp();
    expect(validateProjectDir(d)).toBe(d);
    expect(() => validateProjectDir(path.join(d, "missing"))).toThrow(PathError);
    expect(() => validateProjectDir("relative/dir")).toThrow(/absolute/);
    writeFileSync(path.join(d, "f.txt"), "x");
    expect(() => validateProjectDir(path.join(d, "f.txt"))).toThrow(/not a directory/);
    expect(() => validateProjectDir(path.parse(d).root)).toThrow(/root/);
    expect(() => validateProjectDir(homedir())).toThrow(/home/);
  });

  it("blocks traversal, absolute paths and symlink/junction escapes", () => {
    const root = tmp();
    const outside = tmp();
    mkdirSync(path.join(root, "src"));
    expect(resolveInside(root, "src/new-file.ts")).toBe(path.join(root, "src", "new-file.ts"));
    expect(() => resolveInside(root, "../escape.txt")).toThrow(/escapes/);
    expect(() => resolveInside(root, "src/../../escape.txt")).toThrow(/escapes/);
    expect(() => resolveInside(root, outside)).toThrow(/absolute/);
    expect(() => resolveInside(root, "C:\\Windows\\x")).toThrow(/absolute/);
    expect(() => resolveInside(root, "bad\0name")).toThrow(/invalid/);
    // A directory link inside the project that points outside it. Junctions need no admin rights on Windows.
    symlinkSync(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(() => resolveInside(root, "link/secret.txt")).toThrow(/symlink/);
    expect(() => resolveInside(root, "link")).toThrow(/symlink/);
  });

  it("shows only project-relative paths", () => {
    const root = tmp();
    expect(displayPath(root, path.join(root, "src", "a.ts"))).toBe("src/a.ts");
    expect(displayPath(root, path.join(path.dirname(root), "elsewhere", "x.ts"))).toBe("[outside project]/x.ts");
  });
});

describe("git metadata collection", () => {
  it("reports branch, head and changes without modifying anything", async () => {
    const dir = initRepo();
    writeFileSync(path.join(dir, "a.txt"), "one\nchanged\n");
    writeFileSync(path.join(dir, "new.txt"), "new\n");
    const before = snapshot(dir);
    const info = await collectGitInfo(dir);
    const { diff } = await diffSince(dir, info!.head);
    await checkBase(dir, info!.head!);
    expect(snapshot(dir)).toBe(before);
    expect(info).toMatchObject({ isRepo: true, branch: "main", dirty: true });
    expect(info!.head).toMatch(/^[0-9a-f]{40}$/);
    expect(info!.changedFiles).toEqual(
      expect.arrayContaining([
        { path: "a.txt", status: "M" },
        { path: "new.txt", status: "??" },
      ]),
    );
    expect(diff).toContain("+changed");
  });

  it("returns null outside a repository", async () => {
    expect(await collectGitInfo(tmp())).toBeNull();
  });

  it("detects a stale base", async () => {
    const dir = initRepo();
    const first = gitc(dir, "rev-parse", "HEAD").trim();
    gitc(dir, "checkout", "-q", "-b", "side", "HEAD");
    writeFileSync(path.join(dir, "c.txt"), "c\n");
    gitc(dir, "add", ".");
    gitc(dir, "commit", "-q", "-m", "side");
    const side = gitc(dir, "rev-parse", "HEAD").trim();
    gitc(dir, "checkout", "-q", "main");
    expect(await checkBase(dir, first)).toEqual({ expectedCommit: first, present: true, isAncestorOfHead: true });
    expect(await checkBase(dir, side)).toEqual({ expectedCommit: side, present: true, isAncestorOfHead: false });
    expect((await checkBase(dir, "a".repeat(40))).present).toBe(false);
    expect((await checkBase(dir, "HEAD; rm -rf /")).present).toBe(false);
  });

  it("parses ahead/behind and renames", () => {
    const p = parseStatus("## main...origin/main [ahead 2, behind 3]\0R  new.ts\0old.ts\0 M x.ts\0");
    expect(p).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 2, behind: 3 });
    expect(p.changedFiles).toEqual([
      { path: "new.ts", status: "R" },
      { path: "x.ts", status: "M" },
    ]);
  });

  it("creates an isolated task worktree without touching the main checkout", async () => {
    const dir = initRepo();
    writeFileSync(path.join(dir, "a.txt"), "uncommitted work\n");
    const taskId = "1234abcd-0000-0000-0000-000000000000";
    const wt = await ensureTaskWorktree(dir, taskId);
    expect(wt.branch).toBe("relayroom/task-1234abcd");
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("uncommitted work\n");
    // core.autocrlf may convert line endings on checkout.
    expect(readFileSync(path.join(wt.dir, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("one\n");
    const again = await ensureTaskWorktree(dir, taskId);
    expect(again).toMatchObject({ dir: wt.dir, created: false });
    // The worktree dir is excluded locally, so the main checkout does not see it as untracked.
    const info = await collectGitInfo(dir);
    expect(info!.changedFiles.map((f) => f.path)).toEqual(["a.txt"]);
  });
});

describe("secret handling", () => {
  it("redacts env secrets, token formats and local paths", () => {
    const root = tmp();
    const r = new Redactor(root, { MY_API_KEY: "supersecretvalue123", HARMLESS: "visible-value-123" });
    const text = `key=supersecretvalue123 tok=rr_agent_abcdefghijklmnopqrstuvwxyz0123 gh=ghp_${"a".repeat(36)} file=${path.join(root, "src", "x.ts")} ok=visible-value-123`;
    const out = r.redact(text);
    expect(out).not.toContain("supersecretvalue123");
    expect(out).not.toContain("rr_agent_");
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain(root);
    expect(out).toContain("visible-value-123");
    expect(out).toMatch(/file=\.[\\/]src[\\/]x\.ts/);
  });

  it("never passes the RelayRoom token to the provider process", () => {
    const env = childEnv({ RELAYROOM_AGENT_TOKEN: "rr_agent_x", PATH: "/bin" });
    expect(env.RELAYROOM_AGENT_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });
});

describe("journal", () => {
  it("persists accepted dispatches and unsent completions across restarts", () => {
    const file = path.join(tmp(), "state", "j.json");
    const j = new Journal(file);
    j.recordAccepted("d1");
    j.queueCompletion({ dispatchId: "d1" } as never);
    const reloaded = new Journal(file);
    expect(reloaded.has("d1")).toBe(true);
    expect(reloaded.unsent().map((c) => c.dispatchId)).toEqual(["d1"]);
    reloaded.markSent("d1");
    expect(new Journal(file).unsent()).toEqual([]);
  });
});
