import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunComplete } from "@relayroom/protocol";

interface JournalData {
  /** Dispatch ids this adapter was granted (accepted), newest last. Never executed twice. */
  accepted: string[];
  /** Completions not yet acknowledged by the server; re-sent after reconnect or restart. */
  unsent: RunComplete[];
  /** Provider integration self-test result, keyed by provider + version. */
  selfTest?: Record<string, { ok: boolean; at: string }>;
}

const MAX_ACCEPTED = 1000;

/** Small durable local state file, written atomically (temp file + rename). */
export class Journal {
  private data: JournalData = { accepted: [], unsent: [] };

  constructor(private file: string) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<JournalData>;
      this.data = { accepted: parsed.accepted ?? [], unsent: parsed.unsent ?? [], selfTest: parsed.selfTest ?? {} };
    } catch {
      // New or unreadable journal: start empty.
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  has(dispatchId: string): boolean {
    return this.data.accepted.includes(dispatchId);
  }

  recordAccepted(dispatchId: string): void {
    if (this.has(dispatchId)) return;
    this.data.accepted.push(dispatchId);
    if (this.data.accepted.length > MAX_ACCEPTED) this.data.accepted.splice(0, this.data.accepted.length - MAX_ACCEPTED);
    this.save();
  }

  accepted(): string[] {
    return [...this.data.accepted];
  }

  queueCompletion(c: RunComplete): void {
    this.data.unsent = this.data.unsent.filter((x) => x.dispatchId !== c.dispatchId);
    this.data.unsent.push(c);
    this.save();
  }

  markSent(dispatchId: string): void {
    this.data.unsent = this.data.unsent.filter((x) => x.dispatchId !== dispatchId);
    this.save();
  }

  unsent(): RunComplete[] {
    return [...this.data.unsent];
  }

  selfTest(key: string): { ok: boolean; at: string } | undefined {
    return this.data.selfTest?.[key];
  }

  recordSelfTest(key: string, ok: boolean): void {
    this.data.selfTest = { ...(this.data.selfTest ?? {}), [key]: { ok, at: new Date().toISOString() } };
    this.save();
  }
}
