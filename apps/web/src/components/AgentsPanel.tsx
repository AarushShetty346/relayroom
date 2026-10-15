import { useState } from "react";
import type { AgentDTO, AgentTokenDTO, ProjectDTO, UserDTO } from "@relayroom/protocol";
import { post } from "../api";
import type { Workspace } from "../store";
import { confirmAction } from "./confirm";
import { CopyButton, Icon, Modal, ProviderBadge, StatusDot, ago } from "./ui";

export function AgentsPanel({ user, project, ws }: { user: UserDTO; project: ProjectDTO; ws: Workspace }) {
  const [registering, setRegistering] = useState(false);
  const [token, setToken] = useState<{ agent: AgentDTO; token: string } | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const agents = ws.state.agents.filter((a) => showRevoked || !a.revokedAt);
  return (
    <div className="panel-body">
      <div className="row">
        <button className="btn primary sm" onClick={() => setRegistering(true)}>
          <Icon name="plus" size={13} /> Register agent
        </button>
        <div className="grow" />
        {ws.state.agents.some((a) => a.revokedAt) && (
          <label className="row small muted" style={{ gap: 6 }}>
            <input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} /> revoked
          </label>
        )}
      </div>
      {!ws.state.agents.length && (
        <div className="empty" style={{ padding: 16 }}>
          <Icon name="bot" size={24} />
          <h3>No agents registered</h3>
          <p>Register Claude Code or Codex, then run the RelayRoom adapter on the computer where that agent is installed. The adapter connects out to this server; nothing on your machine is exposed.</p>
        </div>
      )}
      {agents.map((a) => (
        <AgentCard key={a.id} a={a} user={user} project={project} ws={ws} onToken={(t) => setToken({ agent: a, token: t })} />
      ))}
      {registering && (
        <RegisterModal
          projectId={project.id}
          onClose={() => setRegistering(false)}
          onCreated={(r) => {
            ws.upsertAgent(r.agent);
            setRegistering(false);
            setToken(r);
          }}
        />
      )}
      {token && <TokenModal agent={token.agent} token={token.token} onClose={() => setToken(null)} />}
    </div>
  );
}

function AgentCard({ a, user, project, ws, onToken }: { a: AgentDTO; user: UserDTO; project: ProjectDTO; ws: Workspace; onToken: (t: string) => void }) {
  const canAdmin = a.ownerId === user.id || project.ownerId === user.id;
  const task = a.activeTaskId ? ws.state.tasks.find((t) => t.id === a.activeTaskId) : undefined;
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="card col" style={{ gap: 6, opacity: a.revokedAt ? 0.6 : 1 }}>
      <div className="row">
        <StatusDot status={a.status} />
        <span className="card-title">{a.displayName}</span>
        <span className="mono faint small">@{a.handle}</span>
        <span className="grow" />
        <ProviderBadge provider={a.provider} />
      </div>
      <div className="row small" style={{ flexWrap: "wrap", gap: 6 }}>
        {a.revokedAt ? (
          <span className="badge err">revoked</span>
        ) : (
          <span className={`badge ${a.status === "online" ? "ok" : a.status === "busy" ? "warn" : ""}`}>
            {a.status === "offline" ? "adapter offline" : a.status === "busy" ? "working" : "ready"}
          </span>
        )}
        {a.capabilities &&
          (a.capabilities.verified ? (
            <span className="badge ok" title="The adapter's local self-test ran this provider successfully">
              <Icon name="check" size={11} /> verified
            </span>
          ) : (
            <span className="badge warn" title="This adapter has not run its provider self-test on this machine">unverified integration</span>
          ))}
        {a.capabilities?.approvals && (
          <span className="badge" title="In edit runs, actions outside the adapter's allowlist wait for a human Approve/Deny in the room">
            <Icon name="shield" size={11} /> asks for approval
          </span>
        )}
        {a.maxPermission && (
          <span className="badge" title="Maximum permission allowed by the owner's local adapter policy">
            <Icon name="shield" size={11} /> max {a.maxPermission}
          </span>
        )}
        {a.acceptFrom === "owner" && <span className="badge">owner-only</span>}
      </div>
      <dl className="kv small" style={{ margin: 0 }}>
        <dt>Owner</dt>
        <dd>{a.ownerName}</dd>
        {a.providerVersion && (
          <>
            <dt>CLI</dt>
            <dd className="mono ellipsis">{a.providerVersion}</dd>
          </>
        )}
        <dt>Heartbeat</dt>
        <dd>{ago(a.lastHeartbeatAt)}</dd>
        <dt>Current task</dt>
        <dd>
          {task ? (
            <a href="#" onClick={(e) => (e.preventDefault(), window.dispatchEvent(new CustomEvent("rr:open-task", { detail: task.id })))}>
              #{task.number} {task.title}
            </a>
          ) : a.activeDispatchId ? (
            "chat request"
          ) : (
            <span className="faint">none</span>
          )}
        </dd>
        <dt>Last activity</dt>
        <dd className="ellipsis" title={a.lastEvent ?? ""}>
          {a.lastEvent ?? <span className="faint">—</span>} {a.lastEventAt && <span className="faint">· {ago(a.lastEventAt)}</span>}
        </dd>
        {a.repo && (
          <>
            <dt>Repository</dt>
            <dd className="mono">
              <Icon name="git" size={11} /> {a.repo.branch ?? "detached"}
              {a.repo.head ? `@${a.repo.head.slice(0, 7)}` : ""} · {a.repo.changedFiles.length} changed
              {a.repo.behind ? ` · ${a.repo.behind} behind` : ""}
              {a.repo.ahead ? ` · ${a.repo.ahead} ahead` : ""}
            </dd>
          </>
        )}
      </dl>
      {canAdmin && !a.revokedAt && (
        <div className="row">
          <button
            className="btn sm"
            onClick={async () => {
              const ok = await confirmAction({
                title: `Rotate @${a.handle}'s token?`,
                body: "The current token stops working immediately and the running adapter is disconnected. You'll need to restart it with the new token.",
                confirmLabel: "Rotate token",
              });
              if (!ok) return;
              try {
                const r = await post(`/api/agents/${a.id}/rotate-token`);
                onToken(r.token);
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            <Icon name="key" size={12} /> Rotate token
          </button>
          <button
            className="btn sm danger"
            onClick={async () => {
              const ok = await confirmAction({
                title: `Revoke @${a.handle}?`,
                body: "The credential is revoked permanently, the adapter is disconnected, and queued requests are cancelled. A running request is marked interrupted.",
                confirmLabel: "Revoke",
                danger: true,
              });
              if (!ok) return;
              try {
                await post(`/api/agents/${a.id}/revoke`);
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Revoke
          </button>
        </div>
      )}
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}

function RegisterModal({ projectId, onClose, onCreated }: { projectId: string; onClose: () => void; onCreated: (r: AgentTokenDTO) => void }) {
  const [provider, setProvider] = useState<"claude-code" | "codex">("claude-code");
  const [handle, setHandle] = useState("claude");
  const [displayName, setDisplayName] = useState("Claude");
  const [acceptFrom, setAcceptFrom] = useState<"members" | "owner">("members");
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    try {
      onCreated(await post(`/api/projects/${projectId}/agents`, { handle: handle.trim().toLowerCase(), displayName, provider, acceptFrom }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal
      title="Register an agent"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={create} disabled={!handle.trim() || !displayName.trim()}>Register</button>
        </>
      }
    >
      <label className="field">
        Provider
        <select
          className="select"
          value={provider}
          onChange={(e) => {
            const p = e.target.value as "claude-code" | "codex";
            setProvider(p);
            setHandle(p === "codex" ? "codex" : "claude");
            setDisplayName(p === "codex" ? "Codex" : "Claude");
          }}
        >
          <option value="claude-code">Claude Code</option>
          <option value="codex">OpenAI Codex</option>
        </select>
      </label>
      <div className="row">
        <label className="field grow">
          Handle (for @mentions)
          <input className="input mono" value={handle} onChange={(e) => setHandle(e.target.value)} />
        </label>
        <label className="field grow">
          Display name
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
      </div>
      <label className="field">
        Who may instruct it
        <select className="select" value={acceptFrom} onChange={(e) => setAcceptFrom(e.target.value as "members" | "owner")}>
          <option value="members">Any project member</option>
          <option value="owner">Only me</option>
        </select>
      </label>
      <p className="small faint" style={{ margin: 0 }}>
        You become this agent's owner. It runs on your computer through the local adapter, limited to the directory and permission level you configure there.
      </p>
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}

function TokenModal({ agent, token, onClose }: { agent: AgentDTO; token: string; onClose: () => void }) {
  const config = JSON.stringify(
    {
      serverUrl: location.origin,
      projectDir: "/absolute/path/to/your/repo",
      provider: agent.provider === "codex" ? "codex" : "claude-code",
      maxPermission: "read-only",
      allowedCommands: agent.provider === "codex" ? undefined : ["Bash(git status:*)", "Bash(git diff:*)", "Bash(npm test:*)"],
      worktrees: false,
    },
    null,
    2,
  );
  return (
    <Modal title={`Connect @${agent.handle}`} onClose={onClose} wide footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="col">
        <span className="small">
          Agent token — <b>shown once</b>. Keep it out of chat and out of git.
        </span>
        <div className="secret">{token}</div>
        <div className="row">
          <CopyButton text={token} label="Copy token" />
        </div>
      </div>
      <div className="col">
        <span className="small">
          1. On the computer where {agent.provider === "codex" ? "Codex" : "Claude Code"} is installed and logged in, save this as <code>relayroom-adapter.json</code> (set <code>projectDir</code>; raise <code>maxPermission</code> to <code>edit</code> only if you want this agent to change files):
        </span>
        <pre className="snippet">{config}</pre>
        <span className="small">2. Check the setup, optionally verify the provider, then connect:</span>
        <pre className="snippet">{`export RELAYROOM_AGENT_TOKEN=<token>        # PowerShell: $env:RELAYROOM_AGENT_TOKEN="<token>"
npm run adapter -- check --config relayroom-adapter.json
npm run adapter -- self-test --config relayroom-adapter.json
npm run adapter -- run --config relayroom-adapter.json`}</pre>
      </div>
    </Modal>
  );
}
