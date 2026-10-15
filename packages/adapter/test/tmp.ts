import { rmSync } from "node:fs";

/**
 * Removes a test temp directory. Windows can keep a just-exited process's directory locked for a moment
 * (EPERM); retry, and never fail a test run over leftover temp files.
 */
export function removeTemp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // leftover temp files are harmless
  }
}
