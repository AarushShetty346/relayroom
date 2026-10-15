import { spawn, execFile, type ChildProcess } from "node:child_process";
import { accessSync, appendFileSync, constants, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

/** Finds an executable on PATH (honours PATHEXT on Windows). Returns an absolute path or null. */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const isFile = (p: string) => {
    try {
      if (!statSync(p).isFile()) return false;
      if (process.platform !== "win32") accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (path.isAbsolute(cmd)) return isFile(cmd) ? cmd : null;
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())] : [""];
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, cmd + e);
    if (isFile(p)) return p;
  }
  return null;
}

export interface Spawned {
  child: ChildProcess;
  lines: AsyncIterable<string>;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: () => void;
}

/**
 * Spawns a provider CLI without a shell. Arguments are fixed by the driver (user text goes through
 * stdin only), so Windows .cmd shims can be wrapped safely.
 */
export function spawnCli(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; stdin: string }): Spawned {
  const isShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  const child = isShim
    ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [bin, ...args].map(quoteWin).join(" ")], {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    : spawn(bin, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, detached: process.platform !== "win32" });
  let err = "";
  child.stderr?.on("data", (d: Buffer) => {
    err = (err + d.toString("utf8")).slice(-20_000);
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end(opts.stdin);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", (e) => {
      err += `\n${e.message}`;
      resolve({ code: null, signal: null });
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  return { child, lines: rl, stderr: () => err, exited, kill: () => killTree(child) };
}

function quoteWin(a: string): string {
  if (/^[A-Za-z0-9_\-.,:=/\\]+$/.test(a)) return a;
  return `"${a.replace(/"/g, '""')}"`;
}

/** Kills the process and its children (tools the agent started). */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000).unref();
  }
}

export function runVersion(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const isShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    const [file, fargs] = isShim
      ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [bin, ...args].map(quoteWin).join(" ")]]
      : [bin, args];
    execFile(file, fargs, { timeout: 15_000, windowsHide: true, windowsVerbatimArguments: isShim }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim().split("\n")[0]?.slice(0, 120) ?? null);
    });
  });
}

/** Runs a CLI to completion and returns its full stdout, or null on failure/timeout. */
export function runCapture(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const isShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    const [file, fargs] = isShim
      ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [bin, ...args].map(quoteWin).join(" ")]]
      : [bin, args];
    execFile(
      file,
      fargs,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, windowsHide: true, windowsVerbatimArguments: isShim, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * Debugging aid: when RELAYROOM_CAPTURE_STREAM names a file, every raw provider JSON line is appended
 * to it (used to turn real runs into test fixtures). Off by default; the file may contain project code.
 */
export function captureLine(line: string): void {
  const file = process.env.RELAYROOM_CAPTURE_STREAM;
  if (!file) return;
  try {
    appendFileSync(file, line + "\n");
  } catch {
    // capture is best effort
  }
}
