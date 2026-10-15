import { useEffect, useState } from "react";
import type { MessageDTO, ProjectDTO, TaskStatus, UserDTO } from "@relayroom/protocol";
import { post } from "../api";
import type { Workspace } from "../store";
import { AgentsPanel } from "./AgentsPanel";
import { ContextPanel } from "./ContextPanel";
import { TaskDrawer } from "./TaskDrawer";
import { Icon, Modal, TaskStatusBadge, ago } from "./ui";

type Tab = "tasks" | "agents" | "context";

export function RightPanel({ user, project, ws }: { user: UserDTO; project: ProjectDTO; ws: Workspace }) {
  const [tab, setTab] = useState<Tab>("tasks");
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [newTask, setNewTask] = useState<{ body: string; sourceMessageId: string | null } | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => setOpenTask((e as CustomEvent<string>).detail);
    const onNew = (e: Event) => {
      const d = (e as CustomEvent<MessageDTO | { body: string }>).detail;
      setNewTask({ body: d.body, sourceMessageId: "id" in d ? d.id : null });
    };
    window.addEventListener("rr:open-task", onOpen);
    window.addEventListener("rr:new-task", onNew);
    return () => {
      window.removeEventListener("rr:open-task", onOpen);
      window.removeEventListener("rr:new-task", onNew);
    };
  }, []);

  const active = ws.state.tasks.filter((t) => !["completed", "cancelled"].includes(t.status));
  const onlineAgents = ws.state.agents.filter((a) => a.status !== "offline" && !a.revokedAt).length;
  const suggestions = ws.state.memory.filter((m) => m.status !== "verified").length;

  return (
    <aside className="right" aria-label="Project panel">
      <div className="tabs" role="tablist">
        <button className="tab" role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>
          Tasks <span className="count">{active.length}</span>
        </button>
        <button className="tab" role="tab" aria-selected={tab === "agents"} onClick={() => setTab("agents")}>
          Agents <span className="count">{onlineAgents}/{ws.state.agents.filter((a) => !a.revokedAt).length}</span>
        </button>
        <button className="tab" role="tab" aria-selected={tab === "context"} onClick={() => setTab("context")}>
          Context {suggestions > 0 && <span className="badge warn" title="Unverified entries">{suggestions}</span>}
        </button>
      </div>
      {tab === "tasks" && <TasksList ws={ws} onOpen={setOpenTask} onNew={() => setNewTask({ body: "", sourceMessageId: null })} />}
      {tab === "agents" && <AgentsPanel user={user} project={project} ws={ws} />}
      {tab === "context" && <ContextPanel ws={ws} />}
      {openTask && <TaskDrawer taskId={openTask} user={user} ws={ws} onClose={() => setOpenTask(null)} />}
      {newTask && (
        <NewTaskModal
          projectId={project.id}
          initial={newTask}
          onClose={() => setNewTask(null)}
          onCreated={(id) => {
            setNewTask(null);
            setTab("tasks");
            setOpenTask(id);
          }}
        />
      )}
    </aside>
  );
}

const ORDER: TaskStatus[] = ["running", "awaiting_review", "assigned", "blocked", "failed", "queued", "completed", "cancelled"];

function TasksList({ ws, onOpen, onNew }: { ws: Workspace; onOpen: (id: string) => void; onNew: () => void }) {
  const [showClosed, setShowClosed] = useState(false);
  const tasks = ws.state.tasks.filter((t) => showClosed || !["completed", "cancelled"].includes(t.status));
  const grouped = ORDER.map((s) => [s, tasks.filter((t) => t.status === s)] as const).filter(([, l]) => l.length);
  return (
    <div className="panel-body">
      <div className="row">
        <button className="btn primary sm" onClick={onNew}>
          <Icon name="plus" size={13} /> New task
        </button>
        <div className="grow" />
        <label className="row small muted" style={{ gap: 6 }}>
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> show closed
        </label>
      </div>
      {!ws.state.tasks.length && (
        <div className="empty" style={{ padding: 16 }}>
          <Icon name="task" size={24} />
          <h3>No tasks yet</h3>
          <p>Tasks hold the objective, acceptance criteria, assignee and every handoff — so work survives beyond the chat scroll.</p>
        </div>
      )}
      {grouped.map(([status, list]) => (
        <div key={status} className="col" style={{ gap: 6 }}>
          <div className="section-title">
            {status.replace("_", " ")} <span>{list.length}</span>
          </div>
          {list.map((t) => (
            <div key={t.id} className="card clickable" role="button" tabIndex={0} onClick={() => onOpen(t.id)} onKeyDown={(e) => e.key === "Enter" && onOpen(t.id)}>
              <div className="row">
                <span className="mono faint small">#{t.number}</span>
                <span className="card-title grow ellipsis">{t.title}</span>
                <TaskStatusBadge status={t.status} />
              </div>
              <div className="row small faint" style={{ marginTop: 4 }}>
                {t.assignee ? (
                  <span>
                    {t.assignee.type === "agent" ? <Icon name="bot" size={12} /> : <Icon name="user" size={12} />} {t.assignee.name}
                  </span>
                ) : (
                  <span>unassigned</span>
                )}
                {t.branch && (
                  <span className="mono ellipsis">
                    <Icon name="git" size={11} /> {t.branch}
                  </span>
                )}
                <span className="grow" />
                <span>{ago(t.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function NewTaskModal({
  projectId,
  initial,
  onClose,
  onCreated,
}: {
  projectId: string;
  initial: { body: string; sourceMessageId: string | null };
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const firstLine = initial.body.replace(/^(\s*@[\w-]+[,:]?\s*)+/, "").split("\n")[0]!.slice(0, 120);
  const [title, setTitle] = useState(firstLine);
  const [description, setDescription] = useState(initial.body);
  const [criteria, setCriteria] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    try {
      const r = await post(`/api/projects/${projectId}/tasks`, {
        title,
        description,
        acceptanceCriteria: criteria
          .split("\n")
          .map((s) => s.replace(/^[-*]\s*/, "").trim())
          .filter(Boolean),
        sourceMessageId: initial.sourceMessageId,
      });
      onCreated(r.task.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal
      title="New task"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!title.trim()} onClick={create}>Create task</button>
        </>
      }
    >
      <label className="field">
        Title
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        Description
        <textarea className="textarea" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="field">
        Acceptance criteria <span className="faint">(one per line)</span>
        <textarea className="textarea" rows={3} placeholder={"Unit tests pass\nPublic interface unchanged"} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
      </label>
      {initial.sourceMessageId && <span className="small faint">Linked to the chat message it was created from.</span>}
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}
