import { useCallback, useEffect, useState } from "react";
import { allowedTransitions, type HandoffDTO, type PermissionProfile, type TaskDetailDTO, type TaskStatus, type UserDTO } from "@relayroom/protocol";
import { get, patch, post } from "../api";
import type { Workspace } from "../store";
import { CommandResult } from "./Chat";
import { confirmAction } from "./confirm";
import { DiffView, Icon, Modal, ProviderBadge, StatusDot, TaskStatusBadge, ago } from "./ui";

const TRANSITION_LABEL: Partial<Record<TaskStatus, string>> = {
  completed: "Approve & complete",
  failed: "Mark failed",
  blocked: "Mark blocked",
  cancelled: "Cancel task",
  queued: "Move to queue",
  running: "Mark started",
  awaiting_review: "Ready for review",
};

export function TaskDrawer({ taskId, user, ws, onClose }: { taskId: string; user: UserDTO; ws: Workspace; onClose: () => void }) {
  const [detail, setDetail] = useState<TaskDetailDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const live = ws.state.tasks.find((t) => t.id === taskId);

  const load = useCallback(() => {
    get<TaskDetailDTO>(`/api/tasks/${taskId}`)
      .then(setDetail)
      .catch((e) => setErr((e as Error).message));
  }, [taskId]);
  // Reload whenever the live task changes (status, assignee, new handoff).
  useEffect(load, [load, live?.updatedAt, live?.status]);

  if (!detail) {
    return (
      <Modal title="Task" onClose={onClose} wide>
        {err ? <div className="error-text">{err}</div> : <span className="faint">Loading…</span>}
      </Modal>
    );
  }
  const t = detail.task;
  const activeDispatch = detail.dispatches.find((d) => d.status === "running" || d.status === "pending");
  const agentAssigned = t.assignee?.type === "agent";
  const transitions = allowedTransitions(t.status, "human").filter((s) => s !== "assigned" && !(s === "running" && agentAssigned));

  const transition = async (to: TaskStatus) => {
    const risky = to === "cancelled" || to === "failed";
    const ok = await confirmAction({
      title: `${TRANSITION_LABEL[to] ?? to}?`,
      body:
        to === "completed"
          ? "Completing records your review decision. Make sure the reported results and the diff match the acceptance criteria."
          : `Task #${t.number} moves from ${t.status.replace("_", " ")} to ${to.replace("_", " ")}.`,
      confirmLabel: TRANSITION_LABEL[to] ?? "Confirm",
      danger: risky,
    });
    if (!ok) return;
    try {
      await post(`/api/tasks/${t.id}/transition`, { to });
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Modal title={`Task #${t.number}`} onClose={onClose} wide>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="grow col" style={{ gap: 4 }}>
          {editing ? (
            <EditTask detail={detail} onDone={() => (setEditing(false), load())} />
          ) : (
            <>
              <div className="row">
                <h3 style={{ margin: 0, fontSize: 16 }}>{t.title}</h3>
                <TaskStatusBadge status={t.status} />
              </div>
              {t.description && <div className="small" style={{ whiteSpace: "pre-wrap" }}>{t.description}</div>}
              {t.acceptanceCriteria.length > 0 && (
                <div>
                  <div className="section-title">Acceptance criteria</div>
                  <ul className="small" style={{ margin: "4px 0", paddingLeft: 18 }}>
                    {t.acceptanceCriteria.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="row small faint">
                {t.branch && (
                  <span className="mono">
                    <Icon name="git" size={11} /> {t.branch}
                    {t.commit ? `@${t.commit.slice(0, 7)}` : ""}
                  </span>
                )}
                <span>updated {ago(t.updatedAt)}</span>
              </div>
            </>
          )}
        </div>
        {!editing && !["completed", "cancelled"].includes(t.status) && (
          <button className="btn ghost sm" onClick={() => setEditing(true)}>
            <Icon name="edit" size={12} /> Edit
          </button>
        )}
      </div>

      {err && <div className="error-text" role="alert">{err}</div>}

      {activeDispatch && (
        <div className="card row">
          <span className="dot busy" />
          <span className="grow small">
            {activeDispatch.status === "pending" ? "Queued for" : "Running on"} {t.assignee?.name} ({activeDispatch.permission})
          </span>
          <button
            className="btn sm danger"
            onClick={async () => {
              const ok = await confirmAction({ title: "Cancel this run?", body: "The agent's process will be stopped.", confirmLabel: "Cancel run", danger: true });
              if (!ok) return;
              try {
                await post(`/api/dispatches/${activeDispatch.id}/cancel`);
                load();
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            <Icon name="stop" size={11} /> Cancel run
          </button>
        </div>
      )}

      {!["completed", "cancelled", "running"].includes(t.status) && <AssignForm detail={detail} user={user} ws={ws} onDone={load} onError={setErr} />}

      {transitions.length > 0 && (
        <div className="row" style={{ flexWrap: "wrap" }}>
          <span className="small faint">Status:</span>
          {transitions.map((s) => (
            <button key={s} className={s === "completed" ? "btn primary sm" : s === "cancelled" || s === "failed" ? "btn danger sm" : "btn sm"} onClick={() => transition(s)}>
              {TRANSITION_LABEL[s] ?? s}
            </button>
          ))}
        </div>
      )}

      <div className="section-title">Handoffs ({detail.handoffs.length})</div>
      {detail.handoffs.length === 0 && <span className="small faint">No handoffs yet. Agents produce one when a task run finishes.</span>}
      {[...detail.handoffs].reverse().map((h) => (
        <HandoffCard key={h.id} h={h} />
      ))}

      <details className="details">
        <summary>History · {detail.history.length} changes · {detail.dispatches.length} runs</summary>
        <div className="details-body small">
          {detail.history.map((e, i) => (
            <div key={i} className="row">
              <span className="faint" style={{ width: 120 }}>{new Date(e.at).toLocaleString()}</span>
              <span className="grow">
                {e.from ? `${e.from.replace("_", " ")} → ` : ""}
                <b>{e.to.replace("_", " ")}</b> by {e.by.name}
                {e.note ? <span className="faint"> — {e.note}</span> : null}
              </span>
            </div>
          ))}
          {detail.dispatches.map((d) => (
            <div key={d.id} className="row">
              <span className="faint" style={{ width: 120 }}>{new Date(d.createdAt).toLocaleString()}</span>
              <span className="grow">
                run <span className="mono">{d.id.slice(0, 8)}</span> · {d.permission} · <b>{d.status}</b>
                {d.exitCode !== null ? ` · exit ${d.exitCode}` : ""}
                {d.error ? <span className="faint"> — {d.error}</span> : null}
              </span>
            </div>
          ))}
        </div>
      </details>
    </Modal>
  );
}

function EditTask({ detail, onDone }: { detail: TaskDetailDTO; onDone: () => void }) {
  const t = detail.task;
  const [title, setTitle] = useState(t.title);
  const [description, setDescription] = useState(t.description);
  const [criteria, setCriteria] = useState(t.acceptanceCriteria.join("\n"));
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="col">
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
      <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Description" />
      <textarea className="textarea" value={criteria} onChange={(e) => setCriteria(e.target.value)} aria-label="Acceptance criteria, one per line" />
      {err && <div className="error-text">{err}</div>}
      <div className="row">
        <button
          className="btn primary sm"
          onClick={async () => {
            try {
              await patch(`/api/tasks/${t.id}`, { title, description, acceptanceCriteria: criteria.split("\n").map((s) => s.trim()).filter(Boolean) });
              onDone();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Save
        </button>
        <button className="btn sm" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function AssignForm({ detail, user, ws, onDone, onError }: { detail: TaskDetailDTO; user: UserDTO; ws: Workspace; onDone: () => void; onError: (e: string) => void }) {
  const t = detail.task;
  const [value, setValue] = useState(t.assignee ? `${t.assignee.type}:${t.assignee.id}` : "");
  const [permission, setPermission] = useState<PermissionProfile>("edit");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const agents = ws.state.agents.filter((a) => !a.revokedAt);
  const [type, id] = value.split(":") as ["agent" | "user" | "", string];
  const agent = type === "agent" ? agents.find((a) => a.id === id) : undefined;
  const isTransfer = !!t.assignee && value !== `${t.assignee.type}:${t.assignee.id}` && detail.handoffs.length > 0;
  const rerun = !!t.assignee && value === `${t.assignee.type}:${t.assignee.id}`;

  const submit = async (confirmConcurrent = false): Promise<void> => {
    setBusy(true);
    try {
      const r = await post(`/api/tasks/${t.id}/assign`, {
        assignee: type ? { type, id } : null,
        start: type === "agent",
        permission,
        note,
        confirmConcurrent,
      });
      if (r.needsConfirmation) {
        setBusy(false);
        const ok = await confirmAction({
          title: "Possible conflicting work",
          body: (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {r.needsConfirmation.reasons.map((x: string) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ),
          confirmLabel: "Start anyway",
        });
        if (ok) return submit(true);
        return;
      }
      setNote("");
      onDone();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card col">
      <div className="section-title" style={{ margin: 0 }}>{isTransfer ? "Transfer task" : t.assignee ? "Assignment" : "Assign"}</div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <select className="select" style={{ width: 230 }} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Assignee">
          <option value="">Unassigned</option>
          <optgroup label="Agents">
            {agents.map((a) => (
              <option key={a.id} value={`agent:${a.id}`}>
                @{a.handle} — {a.status}
              </option>
            ))}
          </optgroup>
          <optgroup label="People">
            {ws.state.members.map((m) => (
              <option key={m.userId} value={`user:${m.userId}`}>
                {m.displayName}
                {m.userId === user.id ? " (me)" : ""}
              </option>
            ))}
          </optgroup>
        </select>
        {agent && (
          <div className="seg" role="group" aria-label="Permission">
            <button aria-pressed={permission === "read-only"} onClick={() => setPermission("read-only")}>read only</button>
            <button className="warn" aria-pressed={permission === "edit"} onClick={() => setPermission("edit")}>edit files</button>
          </div>
        )}
      </div>
      {agent && (
        <div className="row small">
          <StatusDot status={agent.status} /> <ProviderBadge provider={agent.provider} />
          <span className="faint">
            {agent.status === "offline" ? "Adapter offline — it cannot start until its owner runs the adapter." : agent.maxPermission === "read-only" ? "Owner's local policy: read-only." : "Ready."}
          </span>
        </div>
      )}
      <input className="input" placeholder={isTransfer ? "Transfer note for the next assignee" : "Note for the assignee (optional)"} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="row">
        <button className="btn primary sm" disabled={busy || (!type && !t.assignee) || (agent && agent.status === "offline")} onClick={() => void submit()}>
          {type === "agent" ? (rerun ? "Run again" : isTransfer ? "Transfer & run" : "Assign & run") : type ? "Assign" : "Unassign"}
        </button>
        {isTransfer && <span className="small faint">The new assignee receives the latest handoff and this note.</span>}
      </div>
    </div>
  );
}

function HandoffCard({ h }: { h: HandoffDTO }) {
  const [diff, setDiff] = useState(false);
  const o = h.handoff.observed;
  const r = h.handoff.reported;
  return (
    <div className="card col" style={{ gap: 8 }}>
      <div className="row small">
        <Icon name="handoff" size={13} />
        <b>{h.from.name}</b>
        {h.to && (
          <>
            → <b>{h.to.name}</b>
          </>
        )}
        <span className="grow" />
        <span className="faint">{new Date(h.createdAt).toLocaleString()}</span>
      </div>
      {h.note && <div className="small">{h.note}</div>}
      <div className="observed small">
        <div className="tiny faint">Observed by the adapter</div>
        <dl className="kv" style={{ margin: "4px 0" }}>
          <dt>Exit code</dt>
          <dd>{o.exitCode ?? "unknown"}</dd>
          <dt>Branch</dt>
          <dd className="mono">
            {o.branch ?? "—"}
            {o.headCommit ? ` @ ${o.headCommit.slice(0, 10)}` : ""}
            {o.baseCommit && o.baseCommit !== o.headCommit ? ` (from ${o.baseCommit.slice(0, 10)})` : ""}
          </dd>
          <dt>Provider</dt>
          <dd>
            {o.provider}
            {o.executionId ? <span className="faint mono"> · {o.executionId.slice(0, 18)}</span> : null}
          </dd>
          <dt>Files changed</dt>
          <dd>{o.filesChanged.length ? o.filesChanged.map((f) => `${f.status} ${f.path}`).join(", ") : "none detected"}</dd>
          <dt>Commands</dt>
          <dd>
            {o.commands.length ? (
              <ul className="cmd-list">
                {o.commands.map((c, i) => (
                  <li key={i}>
                    <CommandResult c={c} /> {c.command}
                  </li>
                ))}
              </ul>
            ) : (
              "none observed"
            )}
          </dd>
        </dl>
        {h.diff && (
          <button className="btn sm" onClick={() => setDiff(!diff)}>
            <Icon name="file" size={12} /> {diff ? "Hide diff" : "Show diff"}
          </button>
        )}
        {diff && h.diff && <div style={{ marginTop: 6 }}><DiffView diff={h.diff} truncated={h.diffTruncated} /></div>}
      </div>
      {r ? (
        <div className="reported small">
          <div className="tiny faint">Reported by the agent — claims, not verified</div>
          <dl className="kv" style={{ margin: "4px 0" }}>
            {r.summary && (<><dt>Summary</dt><dd>{r.summary}</dd></>)}
            {r.workCompleted.length > 0 && (<><dt>Work done</dt><dd>{r.workCompleted.join("; ")}</dd></>)}
            <dt>Tests run</dt>
            <dd>{r.testsRun.length ? r.testsRun.join("; ") : "none reported"}</dd>
            {r.testResults && (<><dt>Results</dt><dd>{r.testResults}</dd></>)}
            {r.unresolvedFailures.length > 0 && (<><dt>Unresolved</dt><dd style={{ color: "var(--err)" }}>{r.unresolvedFailures.join("; ")}</dd></>)}
            {r.limitations.length > 0 && (<><dt>Limitations</dt><dd>{r.limitations.join("; ")}</dd></>)}
            {r.nextAction && (<><dt>Next action</dt><dd>{r.nextAction}</dd></>)}
          </dl>
        </div>
      ) : (
        <div className="small faint">The agent did not provide a structured report; only adapter observations are available.</div>
      )}
    </div>
  );
}
