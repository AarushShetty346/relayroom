# RelayRoom — Backlog

Status: `[x]` done and verified, `[!]` done with a stated verification gap, `[ ]` not done.

## P0 — Minimum complete product

- [x] P0.1 Monorepo (npm workspaces), Docker Compose Postgres, config, Drizzle SQL migrations
- [x] P0.2 Accounts, sessions, projects, invitations, membership enforcement on every route and socket room
- [x] P0.3 Durable real-time chat: persistence, broadcast, seq pagination, replies, mentions, nonce dedupe, reconnect catch-up
- [x] P0.4 Agent registry, scoped revocable/rotatable tokens, adapter protocol (hello/heartbeat/dispatch/accept/events/complete/cancel)
- [x] P0.5 Claude Code integration via `claude -p --output-format stream-json` — real successful run verified by `npm run smoke` (no-tool prompt; real tool use not yet observed)
- [x] P0.6 Dispatch, agent replies in the room, execution status, run cards
- [x] P0.7 E2E: human message → real adapter runtime → reply in room (scripted driver) + real-CLI runs in the live stack + `npm run smoke`
- [x] P0.8 README with local run instructions

## P1 — Core differentiators

- [!] P1.1 Codex driver via `codex exec --json` — real CLI runs end to end; success path unobserved (CLI not logged in)
- [x] P1.2 Structured handoffs (observed vs reported), transfers carry the previous handoff
- [x] P1.3 Project memory (verified / suggested / assumption) + bounded context retrieval
- [x] P1.4 Git status, branch/commit, ahead/behind, diffs in handoffs
- [x] P1.5 Cancellation (process-tree kill) + reconnect recovery (interrupted runs, journaled late results)
- [x] P1.6 Authorization, credential revocation/rotation, input validation, concurrency tests (on real Postgres)

## P2

- [x] P2.1 Multiple simultaneous agents (one run per agent, confirmation for concurrent edits)
- [x] P2.2 Git worktree + branch per task (`worktrees: true`)
- [!] P2.3 Agent-to-agent handoffs — human-initiated transfer only; no autonomous agent→agent dispatch
- [x] P2.4 Conflict detection: overlapping uncommitted files, stale base commit, behind upstream
- [x] P2.5 Activity history (task history, run events) and project search
- [!] P2.6 Human-in-the-loop approvals routed into the room — Claude Code, opt-in (`approvals: true`);
  tested with simulations, real permission prompt not yet observed (CLI not logged in). Codex: not supported.

## Not planned for the MVP

- Rate limiting, member removal, password reset, horizontal scaling
