import { parseArgs } from "node:util";
import { ConfigError, loadAdapterConfig, type AdapterConfig } from "./config.js";
import { createClaudeDriver } from "./drivers/claude-code.js";
import { createCodexDriver } from "./drivers/codex.js";
import type { ProviderDriver } from "./drivers/types.js";
import { collectGitInfo } from "./git.js";
import { Journal } from "./journal.js";
import { displayPath } from "./paths.js";
import { Adapter, childEnv, type Logger } from "./runner.js";

const USAGE = `relayroom-adapter <command> --config <file>

Commands:
  run         Connect to RelayRoom and execute dispatched work (default)
  check       Validate the config and directory, detect the provider CLI, show git state (no network)
  self-test   Run one tiny read-only prompt through the provider to verify the integration locally

The agent token is read from RELAYROOM_AGENT_TOKEN or the config's tokenFile. It is never printed.`;

const log: Logger = {
  info: (m, e) => console.log(`[${new Date().toISOString()}] ${m}${e ? " " + JSON.stringify(e) : ""}`),
  warn: (m, e) => console.warn(`[${new Date().toISOString()}] WARN ${m}${e ? " " + JSON.stringify(e) : ""}`),
  error: (m, e) => console.error(`[${new Date().toISOString()}] ERROR ${m}${e ? " " + JSON.stringify(e) : ""}`),
};

export function makeDriver(cfg: AdapterConfig): ProviderDriver {
  const dp = (p: string) => displayPath(cfg.projectDir, p);
  return cfg.provider === "claude-code"
    ? createClaudeDriver({ ...(cfg.providerBin ? { bin: cfg.providerBin } : {}), ...(cfg.allowedCommands ? { allowedCommands: cfg.allowedCommands } : {}), displayPath: dp })
    : createCodexDriver({ ...(cfg.providerBin ? { bin: cfg.providerBin } : {}), displayPath: dp, probeDir: cfg.projectDir });
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: { config: { type: "string", short: "c" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  const cmd = positionals[0] ?? "run";
  if (values.help || !values.config || !["run", "check", "self-test"].includes(cmd)) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  let cfg: AdapterConfig;
  try {
    cfg = loadAdapterConfig(values.config);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof Error) {
      console.error(`Config error: ${err.message}`);
      return 2;
    }
    throw err;
  }
  const driver = makeDriver(cfg);

  if (cmd === "check") {
    const found = await driver.detect();
    const git = await collectGitInfo(cfg.projectDir);
    const journal = new Journal(cfg.journalPath);
    console.log(
      JSON.stringify(
        {
          server: cfg.serverUrl,
          projectDir: cfg.projectDir,
          provider: cfg.provider,
          providerCli: found
            ? { found: true, version: found.version, canEdit: found.canEdit ?? "not determined", ...(found.editNote ? { note: found.editNote } : {}) }
            : { found: false },
          selfTest: found ? (journal.selfTest(`${driver.id}@${found.version ?? "unknown"}`) ?? "not run") : "n/a",
          maxPermission: cfg.maxPermission,
          allowedRequesters: cfg.allowedRequesters ?? "all project members the server allows",
          worktrees: cfg.worktrees,
          git: git ? { branch: git.branch, head: git.head?.slice(0, 12), dirty: git.dirty, changed: git.changedFiles.length } : "not a git repository",
        },
        null,
        2,
      ),
    );
    return found ? 0 : 1;
  }

  if (cmd === "self-test") {
    const found = await driver.detect();
    if (!found) {
      console.error(`${driver.label} CLI not found`);
      return 1;
    }
    const marker = "RELAYROOM_SELF_TEST_OK";
    console.log(`Running a read-only self-test with ${driver.label} ${found.version ?? ""} in ${cfg.projectDir} ...`);
    const ac = new AbortController();
    const res = await driver.run({
      prompt: `This is a connectivity self-test. Do not use any tools. Reply with exactly: ${marker}`,
      cwd: cfg.projectDir,
      permission: "read-only",
      signal: ac.signal,
      timeoutMs: 180_000,
      onEvent: (e) => console.log(`  [${e.type}] ${e.text.slice(0, 200)}`),
      env: childEnv(),
    });
    const ok = res.outcome === "succeeded" && res.finalText.includes(marker);
    new Journal(cfg.journalPath).recordSelfTest(`${driver.id}@${found.version ?? "unknown"}`, ok);
    console.log(
      ok
        ? `Self-test passed (execution id ${res.executionId ?? "n/a"}). The adapter will report this integration as verified.`
        : `Self-test FAILED: outcome=${res.outcome} exit=${res.exitCode} error=${res.errorMessage ?? "none"} reply=${JSON.stringify(res.finalText.slice(0, 300))}`,
    );
    return ok ? 0 : 1;
  }

  const adapter = new Adapter(cfg, driver, log);
  await adapter.start();
  const shutdown = async () => {
    log.info("stopping (finishing or cancelling the current run)...");
    await adapter.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  return await new Promise<number>(() => {});
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
