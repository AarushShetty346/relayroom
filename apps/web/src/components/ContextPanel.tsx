import { useState } from "react";
import type { MemoryDTO, MemoryKind, MemoryStatus } from "@relayroom/protocol";
import { del, patch, post } from "../api";
import type { Workspace } from "../store";
import { confirmAction } from "./confirm";
import { Icon, ago } from "./ui";

const KINDS: { kind: MemoryKind; label: string }[] = [
  { kind: "decision", label: "Decision" },
  { kind: "constraint", label: "Constraint" },
  { kind: "convention", label: "Convention" },
  { kind: "accepted_approach", label: "Accepted approach" },
  { kind: "rejected_approach", label: "Rejected approach" },
  { kind: "open_question", label: "Open question" },
  { kind: "fact", label: "Fact" },
];
const label = (k: MemoryKind) => KINDS.find((x) => x.kind === k)?.label ?? k;

export function ContextPanel({ ws }: { ws: Workspace }) {
  const [adding, setAdding] = useState(false);
  const mem = ws.state.memory;
  const unverified = mem.filter((m) => m.status !== "verified" && m.kind !== "open_question");
  const questions = mem.filter((m) => m.kind === "open_question");
  const verified = mem.filter((m) => m.status === "verified" && m.kind !== "open_question");
  return (
    <div className="panel-body">
      <div className="row">
        <button className="btn primary sm" onClick={() => setAdding(!adding)}>
          <Icon name="plus" size={13} /> Add entry
        </button>
      </div>
      {adding && ws.state.project && <AddEntry projectId={ws.state.project.id} onDone={() => setAdding(false)} />}

      {unverified.length > 0 && (
        <>
          <div className="section-title">Awaiting human review <span>{unverified.length}</span></div>
          <span className="tiny faint">Agent suggestions and assumptions. They are given to agents as UNVERIFIED until someone confirms them.</span>
          {unverified.map((m) => <Entry key={m.id} m={m} />)}
        </>
      )}

      <div className="section-title">Decisions & constraints <span>{verified.length}</span></div>
      {verified.length === 0 && <span className="small faint">Nothing recorded yet. Verified entries are included in agent context automatically.</span>}
      {verified.map((m) => <Entry key={m.id} m={m} />)}

      {questions.length > 0 && (
        <>
          <div className="section-title">Open questions <span>{questions.length}</span></div>
          {questions.map((m) => <Entry key={m.id} m={m} />)}
        </>
      )}

      <div className="section-title">Recent handoffs <span>{ws.state.handoffs.length}</span></div>
      {ws.state.handoffs.length === 0 && <span className="small faint">Handoffs appear when agents finish task runs or tasks are transferred.</span>}
      {ws.state.handoffs.map((h) => (
        <div key={h.id} className="card clickable small" onClick={() => window.dispatchEvent(new CustomEvent("rr:open-task", { detail: h.taskId }))}>
          <div className="row">
            <span className="mono faint">#{h.taskNumber}</span>
            <span className="grow ellipsis"><b>{h.taskTitle}</b></span>
            <span className="faint tiny">{ago(h.createdAt)}</span>
          </div>
          <div className="faint">
            {h.from.name}
            {h.to ? ` → ${h.to.name}` : ""} · {h.handoff.observed.filesChanged.length} files · exit {h.handoff.observed.exitCode ?? "?"}
          </div>
          <div className="ellipsis">{h.handoff.reported?.summary || h.note || <span className="faint">No structured report from the agent.</span>}</div>
        </div>
      ))}
    </div>
  );
}

function Entry({ m }: { m: MemoryDTO }) {
  const [edit, setEdit] = useState(false);
  const [title, setTitle] = useState(m.title);
  const [body, setBody] = useState(m.body);
  const [err, setErr] = useState<string | null>(null);
  const update = async (p: Partial<{ title: string; body: string; status: MemoryStatus }>) => {
    try {
      await patch(`/api/memory/${m.id}`, p);
      setEdit(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="card col" style={{ gap: 4 }}>
      <div className="row small">
        <span className="badge">{label(m.kind)}</span>
        <span className={`badge ${m.status === "verified" ? "ok" : "warn"}`}>{m.status}</span>
        <span className="grow" />
        <span className="tiny faint">
          {m.source.type === "agent" ? "agent " : ""}
          {m.source.name} · {ago(m.updatedAt)}
        </span>
      </div>
      {edit ? (
        <>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Details" />
          <div className="row">
            <button className="btn primary sm" onClick={() => update({ title, body })}>Save</button>
            <button className="btn sm" onClick={() => setEdit(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontWeight: 500 }}>{m.title}</div>
          {m.body && m.body !== m.title && <div className="small muted" style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>}
          {m.taskId && (
            <a href="#" className="tiny" onClick={(e) => (e.preventDefault(), window.dispatchEvent(new CustomEvent("rr:open-task", { detail: m.taskId })))}>
              from a task
            </a>
          )}
        </>
      )}
      {!edit && (
        <div className="row">
          {m.status !== "verified" && (
            <button className="btn sm" onClick={() => update({ status: "verified" })}>
              <Icon name="check" size={12} /> Verify
            </button>
          )}
          {m.status === "verified" && (
            <button className="btn ghost sm" onClick={() => update({ status: "assumption" })}>Mark unverified</button>
          )}
          <button className="btn ghost sm" onClick={() => setEdit(true)}>
            <Icon name="edit" size={12} /> Edit
          </button>
          <button
            className="btn ghost sm"
            onClick={async () => {
              const ok = await confirmAction({ title: "Remove this entry?", body: `“${m.title}” will be removed from project memory.`, confirmLabel: "Remove", danger: true });
              if (!ok) return;
              try {
                await del(`/api/memory/${m.id}`);
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            <Icon name="trash" size={12} /> Remove
          </button>
        </div>
      )}
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}

function AddEntry({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [kind, setKind] = useState<MemoryKind>("decision");
  const [status, setStatus] = useState<MemoryStatus>("verified");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="card col">
      <div className="row">
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} aria-label="Kind">
          {KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>{k.label}</option>
          ))}
        </select>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value as MemoryStatus)} aria-label="Status">
          <option value="verified">Verified</option>
          <option value="assumption">Unverified assumption</option>
        </select>
      </div>
      <input className="input" placeholder="e.g. Tokens are validated for expiry before issuer" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
      <textarea className="textarea" placeholder="Details, rationale, links (optional)" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Details" />
      {err && <div className="error-text">{err}</div>}
      <div className="row">
        <button
          className="btn primary sm"
          disabled={!title.trim()}
          onClick={async () => {
            try {
              await post(`/api/projects/${projectId}/memory`, { kind, status, title, body });
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
