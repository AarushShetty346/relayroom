# RelayRoom — Progress

Last updated: 2026-10-15. Branch `feat/mvp`, pushed to the private GitHub repo; nothing merged into `main`.

## State

P0 and P1 are implemented and tested. P2 items are partly done (see TASKS.md). The MVP definition of done
is met for Claude Code: after logging in the CLI, `npm run smoke -- claude-code` passed (see below).
Codex has still not completed a successful run here (its CLI is not logged in).

Human-in-the-loop approvals (Claude Code, opt-in per adapter) were added on 2026-10-15: protocol events,
`approvals` table + migration `0001_approvals`, server service and routes, adapter MCP permission-prompt
bridge with a local cap, and an Approve/Deny card on the run. See "Approvals" below for what was and
wasn't verified.

## Verified on this machine

- **Real Claude Code success run (2026-10-15).** With the Claude CLI logged in, `npm run smoke --
  claude-code` passed twice from a normal PowerShell terminal: the real adapter spawned Claude Code 2.1.295
  (`claude-opus-5-5`) read-only, its reply `RELAYROOM_SMOKE_OK` reached the shared room as an agent
  message, outcome succeeded, exit 0, ~5–6s. This covers the success path of message → dispatch → real
  CLI → stream parsing → reply in the room. It was a no-tool prompt, so tool use, edits and the handoff
  block are still unobserved (gap 1 below).
- Note for this machine: the Claude desktop app is a Store (MSIX) app, so its bundled CLI is at
  `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code\<version>\…\claude.exe`
  from a normal terminal; the `%APPDATA%\Claude\…` path only exists inside the app's sandbox.

- Full test suite: **97 tests pass** on in-process PGlite (75 before approvals + 22 new). The earlier 75
  also passed on PostgreSQL 16 (Docker), with the concurrency-sensitive files passing 3 consecutive runs;
  the approvals tests were run on PGlite only.
- Typecheck (`strict`, `noUncheckedIndexedAccess`) passes for all packages and scripts; production web build
  succeeds; the server serves the built UI with SPA fallback.
- Live stack (Postgres in Docker + server + Vite + adapters), driven in a browser:
  - sign-in, project view, @mention autocomplete, sending, task creation, assign & run, agent directory,
    narrow/mobile layout (375px) — all working;
  - **real Claude Code CLI** (2.1.295, bundled with the Claude desktop app) spawned by the adapter from a
    chat mention and from a task assignment. The CLI's real output reached the room as a failed run:
    `Claude Code error: Not logged in · Please run /login (api_error)`, exit 1, with branch/commit
    metadata. The task moved to `failed` with a handoff record;
  - **real Codex CLI** (codex-cli 0.162.0-alpha, bundled with the Codex desktop app) spawned the same way:
    progress events streamed live into the run card, then a truthful failure (`401 Unauthorized`), exit 1.
- Flag sets were accepted by both installed CLIs. Claude Code's `init` event confirmed that read-only mode
  exposes exactly the `Glob`, `Grep`, `Read` tools.
- Captured real provider output is committed as test fixtures (machine-specific fields removed).
  Two real-data bugs were found and fixed this way: Claude reports auth failure as
  `subtype: "success"` + `is_error: true`; Codex emits transient `error` events while retrying.

## Approvals: verified vs not

Verified here:
- The installed Claude Code 2.1.295 has a hidden `--permission-prompt-tool <tool>` flag ("MCP tool to use
  for permission prompts (only works with --print)"), absent from `--help`. Its binary also has the expected
  answer format, `{behavior: 'allow', updatedInput?: object} or {behavior: 'deny', message: string}` in a
  single text block, and the call input `{tool_name, input, tool_use_id}`.
- **Real CLI run** with the adapter's flags (`--permission-prompts host --mcp-config <file>
  --permission-prompt-tool mcp__relayroom_approvals__approval_prompt`, edit mode): the CLI accepted them,
  started the adapter's stdio MCP server, and its `init` event reported
  `mcp_servers: [{name: "relayroom_approvals", status: "connected"}]`. It then stopped at "Not logged in",
  so no permission prompt was raised.
- The MCP server itself, over real stdio JSON-RPC (initialize, tools/list, tools/call), forwarding to the
  real loopback bridge, including the wrong-secret case (adapter test; the test plays Claude Code's part).
- Server + adapter flows with **simulations** (SimulatedAdapter, and the real Adapter runtime with a
  scripted driver calling the approvals hook): request/broadcast, who may decide (403 for other members,
  404 for non-members), approve/deny with note, idempotent re-send after reconnect, expiry → deny, cancel
  during wait, run end closes requests, local cap denies without asking (git push in a compound command,
  paths outside the directory, read-only runs, approvals not enabled).
- The UI in a browser against a local server (PGlite) with a simulated adapter: card shows command, full
  input, countdown; Approve with a note and Deny both reached the adapter; history and the room notices
  render; 375px layout fixed (run-card header now wraps).

Not verified:
1. That Claude Code actually **calls** the prompt tool on a real permission prompt, and how it uses the
   answer (e.g. whether `updatedInput` must be present). Needs a logged-in CLI: enable `approvals`, mention
   the agent with edit permission, ask for a non-allowlisted command.
2. Whether the model can also call `mcp__relayroom_approvals__approval_prompt` directly as an ordinary
   tool. If it can, the worst case is a spurious request in the room (the tool executes nothing; the local
   cap still applies). The `init` tool list did not show it, but MCP tools may be deferred there.
3. `MCP_TOOL_TIMEOUT` is set to the approval timeout + 60s for the Claude child so a slow human decision
   isn't cut off; that this env var governs the prompt tool call was not observed.
4. Codex approvals: not built. The installed codex-cli 0.162.0-alpha's experimental app-server protocol
   (from `codex app-server generate-json-schema`) defines `item/commandExecution/requestApproval` and
   `item/fileChange/requestApproval` server requests (decisions `accept`/`acceptForSession`/`decline`/
   `cancel`), so it is feasible, but it needs a new app-server driver and could not be verified here.

## Not verified (honest gaps)

1. **Tool use in real runs.** Claude Code's success path is verified only for a no-tool reply. Tool-use
   events, Bash commands, file edits, the `relayroom-handoff` block and permission denials are still
   tested only with **constructed** stream fixtures and a scripted driver. Next: mention a logged-in agent
   with a task that reads and edits files. Codex: not logged in, no successful run yet (`codex login`,
   then `npm run smoke -- codex`).
2. Whether `--permission-prompts none` denies (rather than errors on) a disallowed Bash call in edit mode
   was not observed for real; denials are parsed from `result.permission_denials`.
3. Codex's `workspace-write` sandbox on Windows was not exercised.
4. Two humans on separate networks over HTTPS/WSS: designed for (outbound adapter connections, secure
   cookies, configurable origins) but only tested on localhost.
5. Rendering of partial token-by-token output: not implemented. Progress is forwarded per event (assistant
   text block, tool use, command), which is what both providers' default JSON streams give.

## Design decisions worth knowing

- Execution is **at-most-once**, not exactly-once: a run interrupted by an adapter crash is marked
  `interrupted` and requires a human retry. A completed result that could not be sent is journaled locally
  and delivered after restart (accepted late, flagged in the UI).
- One running dispatch per agent (partial unique index) and one active run per task.
- Context for a dispatch is retrieved (latest handoffs, scored memory entries, a few related messages,
  bounded to ~24k chars), not the whole chat.
- Observed vs reported is a hard separation in the data model (`Handoff.observed` / `Handoff.reported`).
- Live adapter connections are in-memory: one server process per database.

## Next steps

1. Log in to the provider CLIs and run the smoke tests and self-tests (see gap 1).
2. Log in to Claude Code and observe a real permission prompt reaching the room (Approvals gap 1); then
   consider a Codex app-server driver for Codex approvals.
3. Rate limiting on auth and message endpoints; member removal; invite links (not only codes).
4. Horizontal scaling: move adapter presence and fan-out to Postgres LISTEN/NOTIFY or Redis.
5. Agent-to-agent handoffs without a human click (currently a human transfers the task; the receiving
   agent gets the prior handoff, decisions and expected commit).

## Session log

1. Inspected environment (Node 24, Docker installed but stopped → started; both provider CLIs found
   inside desktop-app installs, both not logged in).
2. Protocol package, Drizzle schema + migration, server core (auth, projects, chat, agents, dispatch).
3. Adapter (drivers, journal, policy, git, redaction, worktrees) and real-CLI captures.
4. Tasks, handoffs, memory, context retrieval, search.
5. Web UI; live browser testing; mobile fix; production serving fix.
6. Tests on PGlite and Postgres; smoke script; docs.
7. Human-in-the-loop approvals for Claude Code (protocol, server, adapter MCP bridge, UI, tests, local UI
   demo `npm run demo:approvals`); Codex app-server approval protocol inspected and left unsupported.
