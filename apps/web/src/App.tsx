import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectDTO, UserDTO } from "@relayroom/protocol";
import { get, post } from "./api";
import { createSocket, useConnection, useWorkspace } from "./store";
import { Icon, Logo, Modal, initials } from "./components/ui";
import { Chat } from "./components/Chat";
import { RightPanel } from "./components/RightPanel";
import { InviteModal, SearchBox } from "./components/Header";
import { ConfirmHost } from "./components/confirm";

export function App() {
  const [user, setUser] = useState<UserDTO | null | undefined>(undefined);
  useEffect(() => {
    get("/api/me")
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
  }, []);
  if (user === undefined) return <div className="auth faint">Loading…</div>;
  if (!user) return <Auth onAuthed={setUser} />;
  return <Shell user={user} onLogout={() => setUser(null)} />;
}

function Auth({ onAuthed }: { onAuthed: (u: UserDTO) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [form, setForm] = useState({ username: "", displayName: "", password: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r =
        mode === "login"
          ? await post("/api/auth/login", { username: form.username.trim().toLowerCase(), password: form.password })
          : await post("/api/auth/signup", { username: form.username.trim().toLowerCase(), displayName: form.displayName.trim(), password: form.password });
      onAuthed(r.user);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth">
      <form className="auth-card col" style={{ gap: 14 }} onSubmit={submit}>
        <div className="brand" style={{ fontSize: 18 }}>
          <Logo size={28} /> RelayRoom
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          One room for your team, your coding agents, their tasks and their handoffs.
        </p>
        <div className="tabs" role="tablist">
          <button type="button" className="tab" role="tab" aria-selected={mode === "login"} onClick={() => setMode("login")}>
            Sign in
          </button>
          <button type="button" className="tab" role="tab" aria-selected={mode === "signup"} onClick={() => setMode("signup")}>
            Create account
          </button>
        </div>
        <label className="field">
          Username
          <input className="input" autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
        </label>
        {mode === "signup" && (
          <label className="field">
            Display name
            <input className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />
          </label>
        )}
        <label className="field">
          Password {mode === "signup" && <span className="faint">(10+ characters)</span>}
          <input className="input" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        </label>
        {err && <div className="error-text" role="alert">{err}</div>}
        <button className="btn primary" disabled={busy} style={{ justifyContent: "center", height: 34 }}>
          {mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}

function projectFromHash(): string | null {
  const m = /^#\/p\/([0-9a-f-]{36})/.exec(location.hash);
  return m ? m[1]! : null;
}

function Shell({ user, onLogout }: { user: UserDTO; onLogout: () => void }) {
  const [projects, setProjects] = useState<ProjectDTO[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(projectFromHash());
  const [modal, setModal] = useState<"new" | "join" | "invite" | null>(null);
  const [drawer, setDrawer] = useState<"left" | "right" | null>(null);
  const socket = useMemo(() => createSocket(), []);
  useEffect(() => () => void socket.close(), [socket]);
  const conn = useConnection(socket);
  const ws = useWorkspace(projectId, socket);

  const loadProjects = useCallback(async () => {
    const r = await get("/api/projects");
    setProjects(r.projects);
    return r.projects as ProjectDTO[];
  }, []);
  useEffect(() => {
    loadProjects().then((ps) => {
      if (!projectFromHash() && ps[0]) select(ps[0].id);
    });
    const onHash = () => setProjectId(projectFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [loadProjects]);

  const select = (id: string) => {
    location.hash = `#/p/${id}`;
    setProjectId(id);
    setDrawer(null);
  };

  const logout = async () => {
    await post("/api/auth/logout").catch(() => {});
    socket.close();
    location.hash = "";
    onLogout();
  };

  const project = projects?.find((p) => p.id === projectId) ?? null;

  return (
    <div className={`app ${drawer === "left" ? "show-left" : ""} ${drawer === "right" ? "show-right" : ""}`}>
      <aside className="sidebar" aria-label="Projects">
        <div className="sidebar-head">
          <div className="brand">
            <Logo /> RelayRoom
          </div>
        </div>
        <div className="sidebar-section">
          <div className="sidebar-label">
            Projects
            <button className="btn ghost icon-btn sm" onClick={() => setModal("new")} aria-label="New project" title="New project">
              <Icon name="plus" size={14} />
            </button>
          </div>
          {projects?.map((p) => (
            <button key={p.id} className="nav-item" aria-current={p.id === projectId} onClick={() => select(p.id)}>
              <span className="hash">#</span>
              <span className="ellipsis grow">{p.name}</span>
              {p.role === "owner" && <span className="tiny faint">owner</span>}
            </button>
          ))}
          {projects && projects.length === 0 && <p className="small faint" style={{ padding: "4px 8px" }}>No projects yet.</p>}
          <button className="nav-item" onClick={() => setModal("join")}>
            <Icon name="link" size={14} /> Join with invite code
          </button>
        </div>
        <div className="sidebar-foot">
          <span className="avatar me">{initials(user.displayName)}</span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellipsis small" style={{ fontWeight: 600 }}>{user.displayName}</div>
            <div className="ellipsis tiny faint">@{user.username}</div>
          </div>
          <button className="btn ghost icon-btn" onClick={logout} title="Sign out" aria-label="Sign out">
            <Icon name="logout" />
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="main-head">
          <button className="btn ghost icon-btn only-narrow" onClick={() => setDrawer(drawer === "left" ? null : "left")} aria-label="Projects">
            <Icon name="menu" />
          </button>
          {project ? (
            <>
              <h1 className="ellipsis"># {project.name}</h1>
              <div className="presence hide-narrow" aria-label="Members">
                {ws.state.members.map((m) => (
                  <span key={m.userId} className={`avatar ${m.online ? "on" : ""}`} title={`${m.displayName} (@${m.username}) — ${m.online ? "online" : "offline"}`}>
                    {initials(m.displayName)}
                  </span>
                ))}
              </div>
              <div className="grow" />
              <div className="hide-narrow">
                <SearchBox projectId={project.id} />
              </div>
              {project.role === "owner" && (
                <button className="btn sm" onClick={() => setModal("invite")}>
                  <Icon name="user" size={13} /> Invite
                </button>
              )}
              <button className="btn ghost icon-btn only-narrow" onClick={() => setDrawer(drawer === "right" ? null : "right")} aria-label="Tasks and agents">
                <Icon name="panel" />
              </button>
            </>
          ) : (
            <h1 className="faint">No project selected</h1>
          )}
        </header>
        {conn !== "online" && (
          <div className={`banner ${conn === "offline" ? "err" : "warn"}`} role="status">
            <Icon name="alert" size={14} />
            {conn === "connecting" ? "Connecting to RelayRoom…" : conn === "reconnecting" ? "Connection lost. Reconnecting — messages you missed will load automatically." : "Offline. Check that the server is running."}
          </div>
        )}
        {ws.state.error && (
          <div className="banner err" role="alert">
            <Icon name="alert" size={14} /> {ws.state.error}
          </div>
        )}
        {project ? (
          <Chat key={project.id} projectId={project.id} user={user} ws={ws} connected={conn === "online"} />
        ) : (
          <div className="empty">
            <Logo size={36} />
            <h3>Create or join a project</h3>
            <p>A project is a shared room for people and their registered coding agents.</p>
            <div className="row" style={{ justifyContent: "center", marginTop: 12 }}>
              <button className="btn primary" onClick={() => setModal("new")}>New project</button>
              <button className="btn" onClick={() => setModal("join")}>Join with invite code</button>
            </div>
          </div>
        )}
      </main>

      {project && <RightPanel user={user} project={project} ws={ws} />}

      {modal === "new" && (
        <NewProjectModal
          onClose={() => setModal(null)}
          onCreated={async (p) => {
            await loadProjects();
            select(p.id);
            setModal(null);
          }}
        />
      )}
      {modal === "join" && (
        <JoinModal
          onClose={() => setModal(null)}
          onJoined={async (p) => {
            await loadProjects();
            select(p.id);
            setModal(null);
          }}
        />
      )}
      {modal === "invite" && project && <InviteModal projectId={project.id} onClose={() => setModal(null)} />}
      <ConfirmHost />
    </div>
  );
}

function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (p: ProjectDTO) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    try {
      const r = await post("/api/projects", { name, description });
      onCreated(r.project);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim()} onClick={create}>Create</button>
        </>
      }
    >
      <label className="field">
        Name
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && create()} />
      </label>
      <label className="field">
        Description <span className="faint">(optional)</span>
        <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}

function JoinModal({ onClose, onJoined }: { onClose: () => void; onJoined: (p: ProjectDTO) => void }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const join = async () => {
    try {
      const r = await post("/api/invites/accept", { code: code.trim() });
      onJoined(r.project);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal
      title="Join a project"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={code.trim().length < 16} onClick={join}>Join</button>
        </>
      }
    >
      <label className="field">
        Invite code from the project owner
        <input className="input mono" placeholder="rr_inv_…" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && join()} />
      </label>
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}
