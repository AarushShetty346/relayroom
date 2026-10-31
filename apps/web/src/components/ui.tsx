import { Fragment, useEffect, useRef, type ReactNode } from "react";
import type { AgentStatus, TaskStatus } from "@relayroom/protocol";

const PATHS: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  x: "M6 6l12 12M18 6L6 18",
  reply: "M9 14L4 9l5-5M4 9h10a6 6 0 016 6v3",
  task: "M9 11l3 3 8-8M20 12v7a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h9",
  bot: "M12 8V4M8 4h8M5 8h14v11H5zM9 13h.01M15 13h.01M9 17h6",
  info: "M12 16v-4M12 8h.01M22 12a10 10 0 11-20 0 10 10 0 0120 0z",
  alert: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
  play: "M6 4l14 8-14 8z",
  stop: "M6 6h12v12H6z",
  git: "M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9",
  file: "M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3",
  menu: "M4 6h16M4 12h16M4 18h16",
  panel: "M3 4h18v16H3zM15 4v16",
  check: "M5 12l5 5L20 7",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  key: "M15 7a4 4 0 11-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0115 7z",
  user: "M20 21a8 8 0 10-16 0M12 13a4 4 0 100-8 4 4 0 000 8z",
  logout: "M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9",
  link: "M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1",
  brain: "M12 5a3 3 0 00-5.8 1A3 3 0 004 11a3 3 0 001 5 3 3 0 005 2 3 3 0 002-1V5zM12 5a3 3 0 015.8 1A3 3 0 0120 11a3 3 0 01-1 5 3 3 0 01-5 2 3 3 0 01-2-1",
  handoff: "M7 17L17 7M17 7H9M17 7v8",
  copy: "M8 8h12v12H8zM4 16V4h12",
  terminal: "M4 17l6-5-6-5M12 19h8",
  trash: "M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z",
};

export function Icon({ name, size = 15, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#1b2030" />
      <path d="M9 10h9a5 5 0 010 10h-3l5 5" stroke="#7aa2ff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Parents pass a new onClose on every render. Keep the latest in a ref so the effect below runs only
  // when the modal opens; re-running it re-focused the first field and scrolled the modal to the top on
  // every live update.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, textarea, select, button.primary, button");
    first?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={wide ? "modal wide" : "modal"} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function StatusDot({ status }: { status: AgentStatus }) {
  return <span className={`dot ${status}`} title={status} aria-label={status} />;
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`badge status st-${status}`}>{status.replace("_", " ")}</span>;
}

export function ProviderBadge({ provider }: { provider: string }) {
  const label = provider === "claude-code" ? "Claude Code" : provider === "codex" ? "Codex" : provider;
  return <span className="badge agent">{label}</span>;
}

export function initials(name: string): string {
  const parts = name.replace(/^@/, "").split(/[\s_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function dayOf(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

export function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(ms: number | undefined | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Renders message text safely (React escapes everything, no raw HTML): ``` fences, a small Markdown subset
 * (paragraphs, - / 1. lists, # headings, **bold**, *italic*, `code`, [links](https://…)) and @mentions.
 * Agents write Markdown, so without this their replies showed literal asterisks.
 * Mentions are highlighted only when they resolve to a known agent or member handle.
 */
export function RichText({ text, agentHandles, userHandles }: { text: string; agentHandles: Set<string>; userHandles: Set<string> }) {
  const parts = text.split(/```(?:[\w-]*)\n?([\s\S]*?)```/g);
  return (
    <div className="msg-text">
      {parts.map((b, i) =>
        i % 2 === 1 ? (
          <pre key={i}>
            <code>{b.replace(/\n$/, "")}</code>
          </pre>
        ) : (
          <Fragment key={i}>{blocks(b, agentHandles, userHandles)}</Fragment>
        ),
      )}
    </div>
  );
}

const LIST_ITEM = /^\s{0,3}(?:([-*+•])|(\d{1,3})[.)])\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

/** Splits text (outside code fences) into paragraphs, lists and headings. */
function blocks(text: string, agents: Set<string>, users: Set<string>): ReactNode[] {
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) out.push(<p key={out.length}>{inline(para.join("\n"), agents, users)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, j) => <li key={j}>{inline(it, agents, users)}</li>);
    out.push(list.ordered ? <ol key={out.length} start={list.start}>{items}</ol> : <ul key={out.length}>{items}</ul>);
    list = null;
  };
  for (const line of text.replace(/^\n+|\n+$/g, "").split("\n")) {
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const li = LIST_ITEM.exec(line);
    if (li) {
      flushPara();
      const ordered = li[2] !== undefined;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, start: ordered ? Number(li[2]) : 1, items: [] };
      }
      list.items.push(li[3]!);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flushPara();
      flushList();
      out.push(<p key={out.length} className="md-h">{inline(h[1]!, agents, users)}</p>);
      continue;
    }
    // An indented line right after a list item continues that item.
    if (list && /^\s{2,}\S/.test(line)) {
      const l: { items: string[] } = list;
      l.items[l.items.length - 1] += "\n" + line.trim();
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out;
}

const INLINE = new RegExp(
  [
    /(?<code>`[^`\n]+`)/.source,
    /(?<link>\[(?<linkText>[^\]\n]+)\]\((?<href>https?:\/\/[^\s)]+)\))/.source,
    /(?<bold>\*\*(?=\S)(?<boldText>[^\n]+?)(?<=\S)\*\*)/.source,
    /(?<italic>(?<![\w*])\*(?=[^\s*])(?<italicText>[^*\n]+?)(?<=\S)\*(?![\w*]))/.source,
    /(?<mention>(?:^|(?<=[\s(\[{,;:!?"']))@[A-Za-z][A-Za-z0-9_-]+)/.source,
  ].join("|"),
  "g",
);

function inline(text: string, agents: Set<string>, users: Set<string>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const g = m.groups!;
    const tok = m[0];
    if (g.code) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (g.link)
      out.push(
        <a key={k++} href={g.href} target="_blank" rel="noopener noreferrer">
          {g.linkText}
        </a>,
      );
    else if (g.bold) out.push(<strong key={k++}>{inline(g.boldText!, agents, users)}</strong>);
    else if (g.italic) out.push(<em key={k++}>{inline(g.italicText!, agents, users)}</em>);
    else {
      const h = tok.slice(1).toLowerCase();
      if (agents.has(h)) out.push(<span key={k++} className="mention agent">{tok}</span>);
      else if (users.has(h)) out.push(<span key={k++} className="mention">{tok}</span>);
      else out.push(tok);
    }
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function DiffView({ diff, truncated }: { diff: string; truncated?: boolean }) {
  return (
    <pre className="diff mono" aria-label="diff">
      {diff.split("\n").map((l, i) => (
        <span
          key={i}
          className={
            l.startsWith("diff --git") || l.startsWith("+++") || l.startsWith("---")
              ? "file"
              : l.startsWith("@@")
                ? "hunk"
                : l.startsWith("+")
                  ? "add"
                  : l.startsWith("-")
                    ? "del"
                    : ""
          }
        >
          {l || " "}
        </span>
      ))}
      {truncated && <span className="hunk">… diff truncated by the adapter</span>}
    </pre>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  return (
    <button
      className="btn sm"
      onClick={async (e) => {
        const b = e.currentTarget;
        try {
          await navigator.clipboard.writeText(text);
          b.textContent = "Copied";
        } catch {
          b.textContent = "Copy failed";
        }
        setTimeout(() => (b.textContent = label), 1500);
      }}
    >
      {label}
    </button>
  );
}
