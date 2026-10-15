import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type ApprovalDTO, type DispatchDTO, type HandoffReported, type MessageDTO, type ObservedCommand, type UserDTO } from "@relayroom/protocol";
import { post } from "../api";
import type { Workspace } from "../store";
import { Composer } from "./Composer";
import { confirmAction } from "./confirm";
import { Icon, RichText, dayOf, duration, initials, timeOf } from "./ui";

export function Chat({ projectId, user, ws, connected }: { projectId: string; user: UserDTO; ws: Workspace; connected: boolean }) {
  const { state } = ws;
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [replyTo, setReplyTo] = useState<MessageDTO | null>(null);
  const agentHandles = useMemo(() => new Set(state.agents.filter((a) => !a.revokedAt).map((a) => a.handle)), [state.agents]);
  const userHandles = useMemo(() => new Set(state.members.map((m) => m.username)), [state.members]);
  const byId = useMemo(() => new Map(state.messages.map((m) => [m.id, m])), [state.messages]);

  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.messages.length, state.runEvents]);

  const onScroll = () => {
    const el = list.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadOlder = async () => {
    const el = list.current!;
    const before = el.scrollHeight;
    await ws.loadOlder();
    requestAnimationFrame(() => (el.scrollTop = el.scrollHeight - before + el.scrollTop));
  };

  let lastDay = "";
  let prev: MessageDTO | null = null;

  return (
    <>
      <div className="messages" ref={list} onScroll={onScroll} role="log" aria-live="polite" aria-label="Conversation">
        {state.hasMore && (
          <div className="load-older">
            <button className="btn sm" onClick={loadOlder}>Load earlier messages</button>
          </div>
        )}
        {state.loaded && state.messages.length === 0 && (
          <div className="empty">
            <Icon name="bot" size={28} />
            <h3>Start the conversation</h3>
            <p>Register an agent in the Agents tab, start its local adapter, then mention it here — for example “@claude summarize the README”.</p>
          </div>
        )}
        {state.messages.map((m) => {
          const day = dayOf(m.createdAt);
          const sep = day !== lastDay ? <div className="day-sep" key={`d-${m.id}`}>{day}</div> : null;
          lastDay = day;
          const grouped =
            !!prev &&
            !sep &&
            prev.kind === m.kind &&
            (m.kind === "human" || m.kind === "agent") &&
            prev.author.id === m.author.id &&
            !m.replyToId &&
            new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
          prev = m;
          return (
            <div key={m.id} id={`m-${m.id}`}>
              {sep}
              <MessageItem
                m={m}
                me={user}
                grouped={grouped}
                replied={m.replyToId ? byId.get(m.replyToId) : undefined}
                ws={ws}
                agentHandles={agentHandles}
                userHandles={userHandles}
                onReply={() => setReplyTo(m)}
              />
            </div>
          );
        })}
      </div>
      <Composer projectId={projectId} user={user} ws={ws} connected={connected} replyTo={replyTo} clearReply={() => setReplyTo(null)} onSent={() => (stick.current = true)} />
    </>
  );
}

function MessageItem({
  m,
  me,
  grouped,
  replied,
  ws,
  agentHandles,
  userHandles,
  onReply,
}: {
  m: MessageDTO;
  me: UserDTO;
  grouped: boolean;
  replied?: MessageDTO;
  ws: Workspace;
  agentHandles: Set<string>;
  userHandles: Set<string>;
  onReply: () => void;
}) {
  if (m.kind === "system") {
    const notice = String(m.meta.notice ?? "");
    const warn = [
      "conflict_risk",
      "stale_base",
      "behind_upstream",
      "run_interrupted",
      "dispatch_rejected",
      "agent_unavailable",
      "approval_requested",
      "approval_expired",
    ].includes(notice);
    const approvalId = typeof m.meta.approvalId === "string" ? m.meta.approvalId : null;
    const stillPending = notice === "approval_requested" && approvalId && ws.state.approvals[approvalId]?.status === "pending";
    return (
      <div className={`line-item system ${warn ? "warn" : ""}`}>
        <Icon name={notice.startsWith("approval_") ? "shield" : warn ? "alert" : "info"} size={13} />
        <span>{m.body}</span>
        {stillPending && m.dispatchId && (
          <button
            className="btn sm"
            onClick={() => document.getElementById(`run-${m.dispatchId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
          >
            Review
          </button>
        )}
        <span className="msg-time">{timeOf(m.createdAt)}</span>
      </div>
    );
  }
  if (m.kind === "task") {
    return (
      <div className="line-item">
        <Icon name="task" size={13} />
        <span>
          <span className="who">{m.author.name}</span> {m.body}
        </span>
        {m.taskId && (
          <button className="btn ghost sm" onClick={() => window.dispatchEvent(new CustomEvent("rr:open-task", { detail: m.taskId }))}>
            Open
          </button>
        )}
        <span className="msg-time">{timeOf(m.createdAt)}</span>
      </div>
    );
  }
  if (m.kind === "event") return <RunCard m={m} ws={ws} me={me} />;

  const isAgent = m.kind === "agent";
  return (
    <div className={`msg ${isAgent ? "agent" : ""} ${grouped ? "grouped" : ""}`}>
      <span className={`avatar ${isAgent ? "agent" : m.author.id === me.id ? "me" : ""}`}>{isAgent ? <Icon name="bot" size={15} /> : initials(m.author.name)}</span>
      <div className="msg-body">
        {replied && (
          <div className="reply-ref" onClick={() => document.getElementById(`m-${replied.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>
            <Icon name="reply" size={12} /> replying to <b>{replied.author.name}</b>: <span className="ellipsis" style={{ maxWidth: 380 }}>{replied.body.slice(0, 120)}</span>
          </div>
        )}
        {!grouped && (
          <div className="msg-head">
            <span className="msg-author">{m.author.name}</span>
            {isAgent && <span className="badge agent">agent</span>}
            <span className="msg-time">{timeOf(m.createdAt)}</span>
          </div>
        )}
        <RichText text={m.body} agentHandles={agentHandles} userHandles={userHandles} />
        {isAgent && <AgentMeta m={m} />}
      </div>
      <div className="msg-actions">
        <button className="btn ghost sm" onClick={onReply} title="Reply">
          <Icon name="reply" size={13} /> Reply
        </button>
        {m.kind === "human" && (
          <button className="btn ghost sm" onClick={() => window.dispatchEvent(new CustomEvent("rr:new-task", { detail: m }))} title="Create a task from this message">
            <Icon name="task" size={13} /> Task
          </button>
        )}
      </div>
    </div>
  );
}

/** Facts reported by the adapter, shown separately from the agent's own words. */
function AgentMeta({ m }: { m: MessageDTO }) {
  const meta = m.meta as {
    outcome?: string;
    exitCode?: number | null;
    durationMs?: number;
    commands?: ObservedCommand[];
    filesChanged?: { path: string; status: string }[];
    branch?: string | null;
    head?: string | null;
    reported?: HandoffReported | null;
    late?: boolean;
  };
  const outcomeClass = meta.outcome === "succeeded" ? "ok" : meta.outcome === "cancelled" ? "" : "err";
  const cmds = meta.commands ?? [];
  const files = meta.filesChanged ?? [];
  return (
    <>
      <div className="msg-meta">
        {meta.outcome && <span className={`badge ${outcomeClass}`}>{meta.outcome}</span>}
        {meta.exitCode !== undefined && meta.exitCode !== null && <span className="badge">exit {meta.exitCode}</span>}
        {meta.durationMs !== undefined && <span className="faint small">{duration(meta.durationMs)}</span>}
        {meta.branch && (
          <span className="badge mono" title={meta.head ?? ""}>
            <Icon name="git" size={11} /> {meta.branch}
            {meta.head ? `@${meta.head.slice(0, 7)}` : ""}
          </span>
        )}
        {meta.late && <span className="badge warn">arrived after interruption</span>}
        {m.taskId && (
          <button className="btn ghost sm" onClick={() => window.dispatchEvent(new CustomEvent("rr:open-task", { detail: m.taskId }))}>
            <Icon name="handoff" size={12} /> Handoff
          </button>
        )}
      </div>
      {(cmds.length > 0 || files.length > 0 || meta.reported) && (
        <details className="details">
          <summary>
            Execution report · {cmds.length} command{cmds.length === 1 ? "" : "s"} observed · {files.length} file{files.length === 1 ? "" : "s"} changed
          </summary>
          <div className="details-body">
            <div className="observed col" style={{ gap: 4 }}>
              <span className="tiny faint">Observed by the adapter</span>
              {cmds.length > 0 ? (
                <ul className="cmd-list">
                  {cmds.map((c, i) => (
                    <li key={i}>
                      <CommandResult c={c} /> <span className="ellipsis">{c.command}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="small faint">No shell commands observed.</span>
              )}
              {files.length > 0 && (
                <ul className="cmd-list">
                  {files.slice(0, 40).map((f) => (
                    <li key={f.path}>
                      <span className="badge">{f.status}</span> {f.path}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {meta.reported && (
              <div className="reported col" style={{ gap: 4 }}>
                <span className="tiny faint">Reported by the agent (not verified)</span>
                {meta.reported.summary && <span className="small">{meta.reported.summary}</span>}
                {meta.reported.testResults && <span className="small">Tests: {meta.reported.testResults}</span>}
                {meta.reported.nextAction && <span className="small">Next: {meta.reported.nextAction}</span>}
              </div>
            )}
          </div>
        </details>
      )}
    </>
  );
}

export function CommandResult({ c }: { c: ObservedCommand }) {
  if (c.exitCode !== null) return <span className={`badge ${c.exitCode === 0 ? "ok" : "err"}`}>exit {c.exitCode}</span>;
  if (c.ok === null) return <span className="badge">?</span>;
  return <span className={`badge ${c.ok ? "ok" : "err"}`} title="The provider reports success/failure, not the numeric exit code">{c.ok ? "ok" : "error"}</span>;
}

/** Live execution card: the agent's adapter accepted the work; progress events stream in here. */
function RunCard({ m, ws, me }: { m: MessageDTO; ws: Workspace; me: UserDTO }) {
  const d: DispatchDTO | undefined = m.dispatchId ? ws.state.dispatches[m.dispatchId] : undefined;
  const events = m.dispatchId ? ws.state.runEvents[m.dispatchId] : undefined;
  const approvals = useMemo(
    () =>
      Object.values(ws.state.approvals)
        .filter((a) => a.dispatchId === m.dispatchId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [ws.state.approvals, m.dispatchId],
  );
  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals.filter((a) => a.status !== "pending");
  const running = d?.status === "running";
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (m.dispatchId && (open || running) && !events) void ws.loadRunEvents(m.dispatchId).catch(() => {});
  }, [open, running, m.dispatchId]);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [events?.length]);
  const show = open || running;
  const statusBadge =
    d?.status === "running" ? (
      <span className="badge warn"><span className="dot busy" style={{ width: 6, height: 6 }} /> running</span>
    ) : d ? (
      <span className={`badge ${d.status === "succeeded" ? "ok" : d.status === "cancelled" ? "" : "err"}`}>{d.status}</span>
    ) : null;
  return (
    <div className="run-card" id={m.dispatchId ? `run-${m.dispatchId}` : undefined}>
      <div className="run-card-head">
        <Icon name="terminal" size={14} className="faint" />
        <span className="grow small">
          <b>{m.author.name}</b> <span className="muted">{m.body.replace(m.author.name, "").trim()}</span>
        </span>
        {pending.length > 0 && (
          <span className="badge warn">
            <Icon name="shield" size={11} /> needs approval
          </span>
        )}
        {statusBadge}
        {running && (
          <button
            className="btn sm danger"
            disabled={busy}
            onClick={async () => {
              const ok = await confirmAction({
                title: "Cancel this run?",
                body: "The adapter will stop the agent's process. Work already written to disk stays as it is.",
                confirmLabel: "Cancel run",
                danger: true,
              });
              if (!ok) return;
              setBusy(true);
              try {
                await post(`/api/dispatches/${m.dispatchId}/cancel`);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="stop" size={11} /> Cancel
          </button>
        )}
        {d && ["interrupted", "failed", "rejected", "cancelled"].includes(d.status) && !d.taskId && (
          <RetryButton dispatchId={d.id} />
        )}
        <button className="btn ghost sm" onClick={() => setOpen(!open)} aria-expanded={show}>
          {show ? "Hide" : "Activity"}
        </button>
      </div>
      {pending.map((a) => (
        <ApprovalCard key={a.id} a={a} me={me} ws={ws} />
      ))}
      {show && decided.length > 0 && (
        <div className="approval-history">
          {decided.map((a) => (
            <div key={a.id} className="small">
              <span className={`badge ${a.status === "approved" ? "ok" : "err"}`}>{a.status}</span>{" "}
              <span className="mono">{a.summary}</span>
              <span className="faint">
                {a.decidedBy ? ` — ${a.decidedBy.name}` : ""}
                {a.reason ? ` (${a.reason})` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      {show && (
        <div className="run-log" ref={log}>
          {!events?.length && <span className="faint">{running ? "Waiting for progress events…" : "No progress events recorded."}</span>}
          {events?.map((e) => (
            <div key={e.seq} className={`ev ${e.type}`}>
              <span className="k">{e.type.replace("_", " ")}</span>
              <span>{e.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Human-in-the-loop: the agent wants to do something outside its adapter's allowlist. The adapter has
 * already checked its own local cap; the run is paused on this until someone allowed decides or the
 * request times out (which denies it).
 */
function ApprovalCard({ a, me, ws }: { a: ApprovalDTO; me: UserDTO; ws: Workspace }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ownerId = ws.state.project?.ownerId;
  const canDecide = me.id === a.requestedBy || me.id === a.agentOwnerId || me.id === ownerId;
  const left = Math.max(0, new Date(a.expiresAt).getTime() - now);
  const mins = Math.floor(left / 60_000);
  const secs = Math.floor((left % 60_000) / 1000);
  const nameOf = (id: string) => ws.state.members.find((x) => x.userId === id)?.displayName ?? "someone";
  const agentName = ws.state.agents.find((x) => x.id === a.agentId)?.displayName ?? "The agent";
  const decide = async (decision: "approve" | "deny") => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post(`/api/approvals/${a.id}/decide`, { decision, reason: reason.trim() });
      ws.upsertApproval(r.approval);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="approval-card" role="group" aria-label={`Approval request: ${a.toolName}`}>
      <div className="approval-head">
        <Icon name="shield" size={14} />
        <span className="grow">
          <b>{agentName}</b> wants to use <span className="badge">{a.toolName}</span>
        </span>
        <span className="faint tiny" title="The adapter denies the action if no one decides in time">
          {left > 0 ? `auto-deny in ${mins}:${String(secs).padStart(2, "0")}` : "timing out…"}
        </span>
      </div>
      <pre className="approval-summary">{a.summary}</pre>
      {a.detail && a.detail !== "{}" && (
        <details className="details">
          <summary>Full tool input</summary>
          <pre className="approval-detail">{a.detail}</pre>
        </details>
      )}
      {canDecide ? (
        <div className="approval-actions">
          <input
            className="input sm grow"
            placeholder="Note for the agent (optional)"
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
            aria-label="Note for the agent"
          />
          <button className="btn sm danger" disabled={busy} onClick={() => void decide("deny")}>
            <Icon name="x" size={11} /> Deny
          </button>
          <button className="btn sm primary" disabled={busy} onClick={() => void decide("approve")}>
            <Icon name="check" size={11} /> Approve
          </button>
        </div>
      ) : (
        <div className="small faint">
          Waiting for {nameOf(a.requestedBy)} (who asked for this run), the agent&apos;s owner or the project owner to decide.
        </div>
      )}
      {err && <div className="error-text tiny">{err}</div>}
    </div>
  );
}

function RetryButton({ dispatchId }: { dispatchId: string }) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button
        className="btn sm"
        title={err ?? "Run the same request again as a new dispatch"}
        onClick={async () => {
          try {
            const r = await post(`/api/dispatches/${dispatchId}/retry`, {});
            if (r.needsConfirmation) {
              const ok = await confirmAction({
                title: "Run it again?",
                body: (
                  <ul>
                    {r.needsConfirmation.reasons.map((x: string) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                ),
                confirmLabel: "Run anyway",
              });
              if (!ok) return;
              await post(`/api/dispatches/${dispatchId}/retry`, { confirmConcurrent: true });
            }
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >
        <Icon name="play" size={11} /> Retry
      </button>
      {err && <span className="error-text tiny">{err}</span>}
    </>
  );
}

