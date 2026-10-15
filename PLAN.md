# RelayRoom — Plan

RelayRoom is a shared coordination layer for humans and their local coding agents (Claude Code, Codex).
One project room holds the chat, the task board, the agent directory, and a durable project memory.
Coding happens on each participant's own machine through a local adapter. The server never gets a shell.

## Environment findings (2026-10-15)

| Item | Finding |
| --- | --- |
| OS | Windows 11, Node 24.19, npm 11.17 (no pnpm) |
| Docker | Docker Desktop 29.8, Compose v5.5 (daemon had to be started) |
| Claude Code | 2.1.295, bundled with the Claude desktop app (not on PATH). Documented headless interface: `claude -p --output-format stream-json --verbose`. `claude auth status` reports not logged in as a standalone CLI. |
| Codex | codex-cli 0.162.0-alpha, bundled with the Codex desktop app (not on PATH). Documented headless interface: `codex exec --json` (JSONL events). `codex login status`: not logged in. |

## Architecture

```
 browser (React)  ──HTTPS + Socket.IO (cookie session)──┐
                                                         ▼
                                     RelayRoom server (Fastify + Socket.IO)
                                        │   PostgreSQL (Drizzle, SQL migrations)
                                        ▲
 adapter (local, per person) ──WSS Socket.IO (agent token)┘  outbound only
     │ spawns
     ▼
 claude -p / codex exec  inside the registered project directory
```

Monorepo (npm workspaces):

- `packages/protocol` — zod schemas shared by everyone: REST payloads, socket events, adapter protocol,
  task state machine, handoff shape. Provider-agnostic.
- `apps/server` — Fastify REST API, Socket.IO (`/` for humans, `/adapter` for adapters), Drizzle + Postgres,
  dispatch queue, routing, task service, memory, context retrieval.
- `apps/web` — React + Vite workspace UI.
- `packages/adapter` — local adapter CLI. Provider drivers (`claude-code`, `codex`) are isolated modules
  behind one `ProviderDriver` interface. Git metadata collection and path validation live here.

## Key decisions

- **Postgres everywhere.** Docker Compose for dev. Tests use real Postgres when `TEST_DATABASE_URL` is set,
  otherwise PGlite (real Postgres compiled to WASM, in-process) so the suite runs without Docker.
- **Drizzle ORM** with generated SQL migrations committed to the repo.
- **Sessions:** random 256-bit token in an httpOnly cookie, SHA-256 hash stored server-side.
  Passwords hashed with Node's built-in scrypt (no native build step on Windows).
- **Agent credentials:** `rr_agent_…` tokens, shown once, stored hashed, revocable. Revocation disconnects
  the live adapter socket.
- **Dispatch semantics: at-most-once execution.** Each dispatch has a unique id and idempotency key.
  The server re-sends un-accepted dispatches on reconnect; the adapter must `accept` before running and the
  server grants each dispatch once (atomic conditional update). The adapter also keeps a local journal of
  accepted dispatch ids. A dispatch that was running when its adapter vanished becomes `interrupted` and is
  never re-run automatically; a human can retry it (new dispatch).
- **Routing:** only explicit `@mentions`, task assignments, or a human-initiated transfer wake an agent.
  Dispatching to a busy agent, or while another agent is running in the same project, needs explicit
  confirmation.
- **Safety:** the adapter's local config is authoritative. It caps the permission profile (`read-only` or
  `edit`), confines the agent to the registered directory, never passes unrestricted-permission flags, and
  can restrict which RelayRoom users may dispatch. Messages are untrusted input.
- **Truthfulness:** handoffs separate *observed* facts (git diff of changed files, commands seen in the
  provider event stream, exit codes) from *reported* claims (the agent's own summary). Agent-proposed
  memory entries are stored as `suggested` until a human verifies them.

## Milestones

1. Monorepo, compose, migrations, config.
2. Auth, projects, invitations, membership enforcement.
3. Durable real-time chat (pagination, replies, mentions, nonce dedupe, reconnect).
4. Agent registry + adapter protocol + dispatch queue.
5. Claude Code driver (real), Codex driver (to the extent verifiable).
6. Tasks, state machine, handoffs, memory, context retrieval, git metadata.
7. Web UI.
8. Tests (unit, API integration, simulated adapter E2E, real provider smoke test if authenticated).
9. Docs.
