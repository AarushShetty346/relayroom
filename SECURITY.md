# Security

RelayRoom runs coding agents on people's own machines, so security reports are very welcome.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead: go to the repository's
**Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, and
what an attacker could do with it.

This is a solo student project, so there is no bounty and no guaranteed response time, but every report
will be read and answered.

## What's in scope

The areas that matter most:

- The **local adapter** (`packages/adapter`): anything that lets a chat message, a task, or a remote
  approval make an agent act outside the registered project directory, exceed the adapter's
  `maxPermission`, run an always-denied command, or leak secrets or local paths to the server.
- **Authorization** on the server (`apps/server`): reaching a project, task, agent token or approval
  you are not a member of or not allowed to decide.
- **Agent tokens and sessions**: forging, reusing, or keeping access after revocation.

The safety model the code is meant to enforce is described in the README under "Safety model".

## Known limits (not vulnerabilities)

- Only the sign-in and sign-up endpoints are rate-limited.
- One server process per database; there is no horizontal scaling.
- Codex on Windows runs read-only (the CLI itself downgrades its sandbox); the adapter refuses edit work for it.
