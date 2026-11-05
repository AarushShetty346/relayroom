# RelayRoom

A shared workspace where people and their **locally installed coding agents** (Claude Code, OpenAI Codex)
work in one project room: one chat, one task board with structured handoffs, one project memory, and
honest execution reports.

> **Status:** early prototype by a solo student developer. It works end to end on one machine and has
> been tested with real Claude Code and Codex runs, but it has **no users yet** and is not
> production-hardened. Feedback and criticism are welcome in [Issues](https://github.com/AarushShetty346/relayroom/issues).

**1-minute demo (a real run, agent wait sped up):** https://youtu.be/BA5JB0wk3IE

The idea: when an agent finishes, its summary ("ran the tests, all pass") is a *claim*. RelayRoom shows that
claim next to what the adapter actually **observed**: the files git says changed, every command the agent
ran or was blocked from running, exit codes, and the diff.

| A human and Claude Code in one room | A handoff: observed vs reported |
| --- | --- |
| ![Room chat](docs/images/room-chat.png) | ![Handoff card](docs/images/handoff.png) |

- The **server** stores messages, membership, tasks, handoffs, memory and agent presence, and routes work.
- Each person runs a small **local adapter** next to their own agent CLI. The adapter connects *out* to the
  server (no inbound ports), runs the agent inside one registered directory, and reports what actually
  happened: exit codes, commands it saw, files git says changed, the diff.
- Only explicit `@mentions`, task assignments, or human-confirmed transfers wake an agent.

```
browser ──HTTPS + Socket.IO (session cookie)──► server (Fastify, Socket.IO, Postgres)
                                                   ▲
adapter (your machine) ──WSS (agent token)─────────┘   outbound only
   └─ spawns `claude -p …` or `codex exec …` in your registered repo
```

## What works today — and what is not verified

| Area | Status |
| --- | --- |
| Accounts, sessions, invitations, membership checks, invite-only sign-up, sign-in rate limit | Done, tested |
| Real-time chat (persisted, paginated, replies, mentions, nonce dedupe, reconnect catch-up) | Done, tested |
| Agent registry, scoped revocable tokens, rotation, presence/heartbeat | Done, tested |
| Dispatch queue (at-most-once execution, reconnect recovery, cancel, retry) | Done, tested |
| Tasks: state machine, assignment, transfer, structured handoffs, review | Done, tested |
| Project memory (verified vs suggested/assumption), context retrieval | Done, tested |
| Git metadata, diffs, stale-base and overlapping-change warnings, per-task worktrees | Done, tested |
| **Claude Code driver** (`claude -p --output-format stream-json`) | Implemented. **Verified with a real successful run** (Claude Code 2.1.295, `npm run smoke -- claude-code` passed) **and a real file-editing task** (`npm run smoke:task`: file created, git change observed, real handoff, task to review). Deny rules verified on both Bash and PowerShell (`npm run check:deny`). |
| **Codex driver** (`codex exec --json`) | Implemented. **Verified with a real successful run** (codex-cli 0.162.0-alpha, signed in with ChatGPT; `npm run smoke -- codex` passed). **Read-only on Windows:** this Codex build turns `workspace-write` into `read-only` there, so it cannot edit files; the adapter detects that and refuses edit work up front. Editing with Codex is untested (needs macOS/Linux). |
| **Approvals** (human Approve/Deny for actions outside the allowlist) | Claude Code only, opt-in per adapter. Protocol, server, adapter and UI done and tested with simulations. The installed CLI accepted the flags and connected to the adapter's MCP tool; **a real permission prompt reaching the room was not observed** (not logged in). Codex: not supported (see below). |

Agents show **"unverified integration"** in the UI until their adapter's `self-test` passes on that
machine. See [PROGRESS.md](PROGRESS.md) for the exact list of what was and wasn't verified.

## Requirements

- Node.js 20.11+ (developed on 24.19) and npm
- Docker (for PostgreSQL), or any PostgreSQL 14+ you point `DATABASE_URL` at
- Git
- For agents: Claude Code and/or Codex installed **and logged in** on the machine that runs the adapter

## Run it locally

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm run db:up
```

```bash
npm run db:migrate
```

```bash
npm run dev
```

The UI is at http://localhost:5173 (Vite proxies `/api` and `/socket.io` to the server on :4000).
Create an account, create a project, and invite teammates from the **Invite** button.

Optional demo data — two local test users (`alice`, `bob`), a shared project and two agents. Put a
password of 10+ characters in `.env` as `SEED_PASSWORD` first (it is only for these local test accounts):

```bash
npm run seed
```

Agent tokens from the seed are written to `.relayroom/dev-<handle>.token` (gitignored).

## Connect a coding agent

1. In the project, open **Agents → Register agent**, pick Claude Code or Codex, and copy the token
   (shown once).
2. On the computer where that CLI is installed and logged in, create `relayroom-adapter.json`:

   ```json
   {
     "serverUrl": "http://localhost:4000",
     "projectDir": "/absolute/path/to/your/repo",
     "provider": "claude-code",
     "maxPermission": "read-only",
     "allowedCommands": ["Bash(git status:*)", "Bash(git diff:*)", "Bash(npm test:*)"],
     "worktrees": false
   }
   ```

   | Key | Meaning |
   | --- | --- |
   | `serverUrl` | `https://…` in production; plain `http` is accepted only for localhost |
   | `projectDir` | The only directory the agent works in. Must exist; filesystem roots and your home directory are refused |
   | `provider` | `claude-code` or `codex` |
   | `providerBin` | Optional path to the CLI if it isn't on `PATH` |
   | `maxPermission` | Local hard cap: `read-only` (default) or `edit`. Requests above it are refused by the adapter |
   | `allowedRequesters` | Optional list of RelayRoom usernames allowed to dispatch to this adapter |
   | `allowedCommands` | Claude Code only: shell commands allowed in edit mode (Claude Code permission-rule syntax) |
   | `worktrees` | Run edit-permission task work in `.relayroom/worktrees/task-<id>` on branch `relayroom/task-<id>` |
   | `timeoutMinutes` | Kill a run after this long (default 30) |
   | `approvals` | Claude Code only, default `false`. In edit runs, ask the room (Approve/Deny) before denying an action outside `allowedCommands`. See [Approvals](#approvals) |
   | `approvalTimeoutMinutes` | How long a run waits for a decision before the action is denied (default 10, max 60) |
   | `tokenFile` | Read the token from a file instead of `RELAYROOM_AGENT_TOKEN` |

3. Set the token and start the adapter:

   ```bash
   export RELAYROOM_AGENT_TOKEN=rr_agent_...
   ```

   ```bash
   npm run adapter -- check --config relayroom-adapter.json
   ```

   ```bash
   npm run adapter -- self-test --config relayroom-adapter.json
   ```

   ```bash
   npm run adapter -- run --config relayroom-adapter.json
   ```

   (PowerShell: `$env:RELAYROOM_AGENT_TOKEN="rr_agent_..."`.) `check` makes no network calls and runs no
   agent. `self-test` sends one tiny read-only prompt through the provider and, if it passes, the agent is
   shown as **verified**.

4. In the room: `@claude summarize the README`. Use the composer's **read only / edit files** toggle to
   grant edit permission for that message, or create a task and **Assign & run**.

### How each provider is invoked

| | Claude Code | Codex |
| --- | --- | --- |
| Command | `claude -p --output-format stream-json --verbose --no-session-persistence --permission-prompts none` | `codex exec --json --ephemeral -C <dir> -c approval_policy=never -` |
| read-only | `--permission-mode default --tools Read,Grep,Glob` | `-s read-only` |
| edit | `--permission-mode acceptEdits` + your `allowedCommands` | `-s workspace-write` |
| edit + `approvals` | `--permission-prompts host --mcp-config <per-run file> --permission-prompt-tool mcp__relayroom_approvals__approval_prompt` | not supported |
| Always denied | `git push/reset --hard/rebase/clean/checkout --/restore/merge/branch -D/filter-branch`, `rm -rf`, `npm publish` | (sandbox) |
| Prompt | stdin | stdin |
| Progress events | assistant text, tool use, Bash commands, file edits | agent messages, command executions (with exit codes), file changes |
| Cancel | process-tree kill | process-tree kill |

The adapter never passes `--dangerously-skip-permissions`, `bypassPermissions`, or
`--dangerously-bypass-approvals-and-sandbox`. Commands a provider refuses are listed in the agent's reply
as "Blocked by the local permission policy", so a human can decide what to do — or, with `approvals`
on, decide while the run waits.

### Approvals

With `"approvals": true` in the adapter config (Claude Code, edit runs only), an action outside the
allowlist pauses the run and shows an **Approve / Deny** card on the run in the room, with the exact
command or file and the full tool input. How it works:

1. The Claude Code driver starts a small loopback HTTP bridge (127.0.0.1, random port, random per-run
   secret) and passes Claude Code a per-run MCP config that starts `packages/adapter/mcp/approval-server.mjs`
   (stdio MCP server, Node built-ins only) plus `--permission-prompt-tool`. That flag is hidden from
   `claude --help` in 2.1.295 but present in the binary, which also documents the expected answer:
   `{behavior: 'allow', updatedInput?}` or `{behavior: 'deny', message}`.
2. When Claude Code needs permission it calls the tool; the MCP server forwards the call to the bridge.
3. The adapter applies its **local cap first**. Denied without asking anyone: everything in read-only runs,
   file tools on paths outside the run directory (symlinks resolved), the always-denied commands (also
   inside compound commands such as `npm test && git push`), and the approval tool itself.
4. Otherwise the adapter sends `approval:request` over its existing connection. The server stores it,
   posts a notice in the room and broadcasts it. Only the person who asked for the run, the agent's owner
   or the project owner can decide; other members see who they are waiting for.
5. The decision goes back to the adapter (`approval:decision`). Approve returns the **original** tool
   input unchanged; Deny passes the human's optional note to the agent. No answer within
   `approvalTimeoutMinutes` = denied (server expiry, with a local backstop in the adapter). Cancelling the
   run, the run ending, or the adapter being interrupted closes open requests.

Every request and decision is recorded in the room (who approved what, with the note).

**Codex:** not supported. `codex exec` has no prompt channel, so the adapter keeps
`approval_policy=never`. The installed codex-cli 0.162.0-alpha's `codex app-server generate-json-schema`
shows the experimental app-server protocol does define server-to-client approval requests
(`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, answered with
`accept` / `decline` / `cancel`), so it could be built on that, but it would mean replacing the `exec`
driver with an app-server client, and it could not be verified here (not logged in).

## Safety model

- **Server ≠ shell.** The server can only send a task description. Whether and how it runs is decided by the
  adapter's local config and the agent's own permission system.
- **Messages are untrusted input.** Prompts tell the agent that requests cannot change its rules; the
  adapter enforces its permission cap and requester allowlist before accepting work.
- **Tokens** are random, stored hashed, shown once, revocable and rotatable. Revocation disconnects the
  adapter immediately. The adapter strips its own token from the agent's environment and redacts
  secret-looking environment values, common credential formats and absolute local paths from everything
  it sends.
- **At-most-once execution.** The adapter must be granted a dispatch before running it; the server grants
  each one once, and the adapter journals what it ran. A run interrupted by a crash is marked
  `interrupted`, never silently re-run; humans can retry.
- **Concurrent work** (busy agent, another agent editing) needs explicit confirmation. Overlapping
  uncommitted changes and stale bases produce warnings in the room.
- **No automatic merges or pushes.** Agents can't complete tasks; a human approves from
  `awaiting_review`.
- **Approvals are capped locally** (opt-in, Claude Code only): a remote Approve can only unlock what the
  adapter's own policy allows in principle; read-only runs, out-of-directory paths and the always-denied
  commands are refused on the adapter's machine before anyone is asked. Approve never changes the tool
  input.
- **Honest reporting.** Handoffs separate *observed* facts (git, exit codes, commands seen) from *reported*
  claims (the agent's own summary). Agent-proposed decisions are stored as unverified suggestions until a
  human verifies them.

## Tests

```bash
npm test
```

114 tests across protocol, adapter, server and web rendering. They run on in-process PGlite by default. To run against
real Postgres (each test file creates and drops its own database):

```bash
TEST_DATABASE_URL=postgres://relayroom:relayroom_dev_only@127.0.0.1:5433/relayroom npm test
```

Tests that use `SimulatedAdapter` or a scripted driver are labelled **simulations**: they prove RelayRoom's
own behaviour, not provider integration. Parser tests include real captured provider output
(`packages/adapter/test/fixtures/*.real.jsonl`).

Real-provider smoke test (spends one tiny prompt of provider quota; exits 0 only if the agent's real
reply reaches the room):

```bash
npm run smoke -- claude-code
```

```bash
npm run smoke -- codex
```

Pass the CLI path as a third argument if it isn't on `PATH`.

Real task test: the agent gets edit permission in a throwaway repo, must create a file, run git, and
write a handoff. Add `deny` at the end for the safety variant, which asks it to push to a real local remote:

```bash
npm run smoke:task -- claude-code
```

Deny-rule check: real Claude Code, no RelayRoom prompt, every git command allowed; a push must still be
refused through both Bash and PowerShell:

```bash
npm run check:deny
```

On Windows from a normal terminal, Claude Code bundled with the Claude desktop app is at
`%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude-code\<version>\<hash>\claude.exe`.
Set `RELAYROOM_CAPTURE_STREAM=<file>` to save a run's raw provider output (it may contain project code).

Approvals UI demo against a **local** server (a simulated adapter raises one request and prints a
throwaway login; approve or deny it in the browser):

```bash
npm run demo:approvals -- http://localhost:4000
```

## Running it for other people

The quickest way to let teammates on other networks in is an HTTPS tunnel or reverse proxy in front of
your machine:

```bash
npm run build:web
```

```bash
npm run serve:public -- https://<your-public-address>
```

`serve:public` serves the built UI from the same origin and turns on secure cookies, **invite-only
sign-up** (`SIGNUP_MODE=invite`: accounts can only be created with a project invite code) and a per-IP
sign-in/sign-up rate limit (`AUTH_RATE_LIMIT`, default 20 per minute). On an invite-only server, create
the first (owner) account on the server machine; a random password is printed once:

```bash
npm run create-user -- <username> "<Display Name>"
```

To run it yourself instead: `npm run build:web`, then start the server with `WEB_DIST=apps/web/dist`,
put it behind HTTPS, and set `COOKIE_SECURE=true`, `SIGNUP_MODE=invite` and `WEB_ORIGIN` to the public
origin. Adapters then use `https://…`.

Limits:

- One server process per database: live adapter connections and presence are kept in memory.
- The server runs TypeScript through `tsx` (no separate build step).
- Not production-hardened: no password reset, no email invites, no member removal, no audit export, and
  only the auth endpoints are rate-limited.

## Layout

```
packages/protocol   zod schemas + types shared by everything (REST, sockets, adapter protocol, task state machine)
packages/adapter    local adapter: CLI, runner, Claude Code + Codex drivers, git, path checks, redaction, journal
apps/server         Fastify + Socket.IO + Drizzle/Postgres; services; SQL migrations in apps/server/drizzle
apps/web            React + Vite workspace UI
scripts             dev seed, create-user, serve:public, real-provider smoke/task/deny checks, approvals demo
docs/images         screenshots used in this README
```

Development notes: [PLAN.md](PLAN.md) (original plan), [TASKS.md](TASKS.md) (backlog),
[PROGRESS.md](PROGRESS.md) (what was and wasn't verified, and how).

## Security

Please report vulnerabilities privately, not in a public issue. See [SECURITY.md](SECURITY.md).

## License

Source-available, all rights reserved; see [LICENSE](LICENSE). You're welcome to read the code and run it
locally to try it out. No open-source license has been chosen yet; for any other use, please open an issue
and ask.

Built by [Aarush Shetty](https://github.com/AarushShetty346), with a lot of help from Claude Code.
