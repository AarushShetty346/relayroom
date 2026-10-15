import { useEffect, useRef, useState } from "react";
import type { InviteDTO, MemoryDTO, MessageDTO, TaskDTO } from "@relayroom/protocol";
import { del, get, post } from "../api";
import { CopyButton, Icon, Modal, TaskStatusBadge, ago, timeOf } from "./ui";

export function InviteModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [invites, setInvites] = useState<InviteDTO[]>([]);
  const [created, setCreated] = useState<InviteDTO | null>(null);
  const [maxUses, setMaxUses] = useState(1);
  const [hours, setHours] = useState(72);
  const [err, setErr] = useState<string | null>(null);
  const load = () => get(`/api/projects/${projectId}/invites`).then((r) => setInvites(r.invites));
  useEffect(() => {
    void load();
  }, [projectId]);
  const create = async () => {
    try {
      const r = await post(`/api/projects/${projectId}/invites`, { maxUses, expiresInHours: hours });
      setCreated(r.invite);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal title="Invite people" onClose={onClose}>
      <p className="small muted" style={{ margin: 0 }}>
        Invite codes are shown once. Send it privately; the person signs in and uses “Join with invite code”.
      </p>
      <div className="row">
        <label className="field grow">
          Uses
          <input className="input" type="number" min={1} max={50} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} />
        </label>
        <label className="field grow">
          Expires in (hours)
          <input className="input" type="number" min={1} max={336} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
        </label>
        <button className="btn primary" style={{ alignSelf: "flex-end" }} onClick={create}>
          Create code
        </button>
      </div>
      {err && <div className="error-text">{err}</div>}
      {created?.code && (
        <div className="col">
          <div className="secret">{created.code}</div>
          <div className="row">
            <CopyButton text={created.code} label="Copy code" />
            <span className="tiny faint">You won't be able to see this code again.</span>
          </div>
        </div>
      )}
      {invites.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          <div className="section-title">Existing invites</div>
          {invites.map((i) => {
            const dead = i.revokedAt || i.uses >= i.maxUses || new Date(i.expiresAt) < new Date();
            return (
              <div key={i.id} className="row small">
                <span className="grow muted">
                  {i.uses}/{i.maxUses} used · expires {new Date(i.expiresAt).toLocaleString()}
                </span>
                {i.revokedAt ? (
                  <span className="badge">revoked</span>
                ) : dead ? (
                  <span className="badge">inactive</span>
                ) : (
                  <button className="btn sm danger" onClick={async () => (await del(`/api/projects/${projectId}/invites/${i.id}`), load())}>
                    Revoke
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

export function SearchBox({ projectId }: { projectId: string }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ messages: MessageDTO[]; tasks: TaskDTO[]; memory: MemoryDTO[] } | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (q.trim().length < 2) return setRes(null);
    const t = setTimeout(() => {
      get(`/api/projects/${projectId}/search?q=${encodeURIComponent(q.trim())}`)
        .then(setRes)
        .catch(() => setRes(null));
    }, 250);
    return () => clearTimeout(t);
  }, [q, projectId]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const jump = (id: string) => {
    document.getElementById(`m-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setOpen(false);
  };
  return (
    <div ref={box} style={{ position: "relative" }}>
      <div className="row" style={{ position: "relative" }}>
        <Icon name="search" size={13} className="faint" />
        <input
          className="input"
          style={{ width: 200, height: 30, padding: "4px 8px" }}
          placeholder="Search messages, tasks…"
          aria-label="Search project"
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        />
      </div>
      {open && res && (
        <div className="search-results" role="listbox">
          {res.tasks.map((t) => (
            <div key={t.id} className="hit row" onClick={() => window.dispatchEvent(new CustomEvent("rr:open-task", { detail: t.id }))}>
              <span className="faint mono">#{t.number}</span> <span className="grow ellipsis">{t.title}</span> <TaskStatusBadge status={t.status} />
            </div>
          ))}
          {res.memory.map((m) => (
            <div key={m.id} className="hit">
              <span className="badge">{m.kind.replace("_", " ")}</span> {m.title}
            </div>
          ))}
          {res.messages.map((m) => (
            <div key={m.id} className="hit" onClick={() => jump(m.id)}>
              <div className="tiny faint">
                {m.author.name} · {timeOf(m.createdAt)} · {ago(m.createdAt)}
              </div>
              <div className="ellipsis">{m.body}</div>
            </div>
          ))}
          {!res.tasks.length && !res.memory.length && !res.messages.length && <div className="hit faint">No matches</div>}
        </div>
      )}
    </div>
  );
}
