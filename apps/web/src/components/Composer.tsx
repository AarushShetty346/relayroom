import { useEffect, useMemo, useRef, useState } from "react";
import { extractMentions, type MessageDTO, type PermissionProfile, type SendMessageResult, type UserDTO } from "@relayroom/protocol";
import { post } from "../api";
import { uuid } from "../uuid";
import type { Workspace } from "../store";
import { confirmAction } from "./confirm";
import { Icon, ProviderBadge, StatusDot, initials } from "./ui";

interface Suggestion {
  handle: string;
  label: string;
  kind: "agent" | "user";
  status?: "online" | "busy" | "offline";
  provider?: string;
}

const DRAFT_KEY = (pid: string) => `rr:draft:${pid}`;

export function Composer({
  projectId,
  user,
  ws,
  connected,
  replyTo,
  clearReply,
  onSent,
}: {
  projectId: string;
  user: UserDTO;
  ws: Workspace;
  connected: boolean;
  replyTo: MessageDTO | null;
  clearReply: () => void;
  onSent: () => void;
}) {
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_KEY(projectId)) ?? "";
    } catch {
      return "";
    }
  });
  const [permission, setPermission] = useState<PermissionProfile>("read-only");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [caret, setCaret] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  /** The nonce for the current draft: a retried send of the same draft is deduplicated by the server. */
  const nonce = useRef(uuid());

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY(projectId), text);
    } catch {
      /* storage unavailable */
    }
  }, [text, projectId]);
  useEffect(() => {
    if (replyTo) ta.current?.focus();
  }, [replyTo]);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [text]);

  const agents = ws.state.agents.filter((a) => !a.revokedAt);
  const mentionedAgents = useMemo(() => {
    const hs = extractMentions(text);
    return agents.filter((a) => hs.includes(a.handle));
  }, [text, agents]);

  // @-autocomplete for the token under the caret.
  const token = /(^|\s)@([A-Za-z0-9_-]*)$/.exec(text.slice(0, caret));
  const suggestions: Suggestion[] = useMemo(() => {
    if (!token) return [];
    const q = token[2]!.toLowerCase();
    const a: Suggestion[] = agents
      .filter((x) => x.handle.startsWith(q) || x.displayName.toLowerCase().startsWith(q))
      .map((x) => ({ handle: x.handle, label: x.displayName, kind: "agent", status: x.status, provider: x.provider }));
    const u: Suggestion[] = ws.state.members
      .filter((m) => m.userId !== user.id && (m.username.startsWith(q) || m.displayName.toLowerCase().startsWith(q)))
      .map((m) => ({ handle: m.username, label: m.displayName, kind: "user" }));
    return [...a, ...u].slice(0, 8);
  }, [token?.[2], agents, ws.state.members]);

  const pick = (s: Suggestion) => {
    const before = text.slice(0, caret).replace(/@([A-Za-z0-9_-]*)$/, `@${s.handle} `);
    const next = before + text.slice(caret);
    setText(next);
    setCaret(before.length);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(before.length, before.length);
    });
  };

  const send = async (confirmConcurrent = false) => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setErr(null);
    try {
      const r = await post<SendMessageResult>(`/api/projects/${projectId}/messages`, {
        body,
        replyToId: replyTo?.id ?? null,
        clientNonce: nonce.current,
        permission,
        confirmConcurrent,
      });
      if (r.needsConfirmation) {
        setSending(false);
        const ok = await confirmAction({
          title: "Possible conflicting work",
          body: (
            <>
              <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>
                {r.needsConfirmation.reasons.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              Send anyway?
            </>
          ),
          confirmLabel: "Send anyway",
        });
        if (ok) return send(true);
        return;
      }
      if (r.message) ws.addMessages([r.message]);
      setText("");
      nonce.current = uuid();
      clearReply();
      setPermission("read-only");
      onSent();
    } catch (e) {
      setErr(`${(e as Error).message}. Your message was kept; press Enter to retry.`);
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (e.key === "ArrowDown") return e.preventDefault(), setSel((sel + 1) % suggestions.length);
      if (e.key === "ArrowUp") return e.preventDefault(), setSel((sel - 1 + suggestions.length) % suggestions.length);
      if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), pick(suggestions[sel] ?? suggestions[0]!);
      if (e.key === "Escape") return setCaret(0);
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
    if (e.key === "Escape" && replyTo) clearReply();
  };

  const offlineAgents = mentionedAgents.filter((a) => a.status === "offline");

  return (
    <div className="composer">
      {suggestions.length > 0 && (
        <div className="suggest" role="listbox" aria-label="Mention suggestions">
          {suggestions.map((s, i) => (
            <button key={s.kind + s.handle} role="option" aria-selected={i === sel} onMouseDown={(e) => (e.preventDefault(), pick(s))}>
              {s.kind === "agent" ? <StatusDot status={s.status!} /> : <span className="avatar" style={{ width: 20, height: 20, fontSize: 10 }}>{initials(s.label)}</span>}
              <span className="grow">
                <b>@{s.handle}</b> <span className="faint small">{s.label}</span>
              </span>
              {s.kind === "agent" ? <ProviderBadge provider={s.provider!} /> : <span className="badge">member</span>}
            </button>
          ))}
        </div>
      )}
      <div className="composer-box">
        {replyTo && (
          <div className="replying">
            <Icon name="reply" size={12} /> Replying to <b>{replyTo.author.name}</b>
            <span className="ellipsis grow faint">{replyTo.body.slice(0, 100)}</span>
            <button className="btn ghost icon-btn sm" onClick={clearReply} aria-label="Cancel reply">
              <Icon name="x" size={12} />
            </button>
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={agents.length ? `Message the room — @${agents[0]!.handle} to instruct an agent` : "Message the room"}
          aria-label="Message"
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setSel(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKey}
        />
        <div className="composer-bar">
          {mentionedAgents.length > 0 ? (
            <>
              <span className="small faint">
                <Icon name="bot" size={12} /> {mentionedAgents.map((a) => "@" + a.handle).join(", ")} may
              </span>
              <div className="seg" role="group" aria-label="Agent permission">
                <button aria-pressed={permission === "read-only"} onClick={() => setPermission("read-only")} title="The agent may read but not modify files">
                  read only
                </button>
                <button
                  className="warn"
                  aria-pressed={permission === "edit"}
                  onClick={() => setPermission("edit")}
                  title="The agent may modify files in its registered directory (still limited by its owner's local policy)"
                >
                  edit files
                </button>
              </div>
              {offlineAgents.length > 0 && <span className="small" style={{ color: "var(--warn)" }}>{offlineAgents.map((a) => "@" + a.handle).join(", ")} offline</span>}
            </>
          ) : (
            <span className="hint">Enter to send · Shift+Enter for a new line · @ to mention</span>
          )}
          <div className="grow" />
          <button
            className="btn ghost sm"
            disabled={!text.trim()}
            title="Create a task from this text"
            onClick={() => window.dispatchEvent(new CustomEvent("rr:new-task", { detail: { body: text } }))}
          >
            <Icon name="task" size={13} /> Task
          </button>
          <button className="btn primary sm" disabled={!text.trim() || sending} onClick={() => void send()}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
      {err && <div className="error-text" role="alert" style={{ marginTop: 6 }}>{err}</div>}
      {!connected && !err && <div className="hint" style={{ marginTop: 6 }}>Live updates are paused; sending still works and the room will catch up when the connection returns.</div>}
    </div>
  );
}
