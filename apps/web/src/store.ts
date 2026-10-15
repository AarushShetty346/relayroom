import { useCallback, useEffect, useReducer, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  AgentDTO,
  ApprovalDTO,
  DispatchDTO,
  HandoffDTO,
  MemberDTO,
  MemoryDTO,
  MessageDTO,
  ProjectDTO,
  RunEventDTO,
  ServerToClientEvents,
  TaskDTO,
} from "@relayroom/protocol";
import { get } from "./api";

export type Conn = "connecting" | "online" | "reconnecting" | "offline";
export type RecentHandoff = HandoffDTO & { taskNumber: number; taskTitle: string };

export interface WorkspaceState {
  project: ProjectDTO | null;
  members: MemberDTO[];
  messages: MessageDTO[];
  hasMore: boolean;
  agents: AgentDTO[];
  tasks: TaskDTO[];
  memory: MemoryDTO[];
  dispatches: Record<string, DispatchDTO>;
  runEvents: Record<string, RunEventDTO[]>;
  /** Human-in-the-loop requests, keyed by id. */
  approvals: Record<string, ApprovalDTO>;
  handoffs: RecentHandoff[];
  error: string | null;
  loaded: boolean;
}

const initial: WorkspaceState = {
  project: null,
  members: [],
  messages: [],
  hasMore: false,
  agents: [],
  tasks: [],
  memory: [],
  dispatches: {},
  runEvents: {},
  approvals: {},
  handoffs: [],
  error: null,
  loaded: false,
};

type Action =
  | { t: "reset" }
  | { t: "loaded"; s: Partial<WorkspaceState> }
  | { t: "messages"; m: MessageDTO[]; hasMore?: boolean }
  | { t: "agent"; a: AgentDTO }
  | { t: "task"; task: TaskDTO }
  | { t: "dispatch"; d: DispatchDTO }
  | { t: "runEvent"; e: RunEventDTO }
  | { t: "runEvents"; id: string; e: RunEventDTO[] }
  | { t: "approval"; a: ApprovalDTO }
  | { t: "memory"; m: MemoryDTO | { id: string; deleted: true } }
  | { t: "presence"; userId: string; online: boolean }
  | { t: "patch"; s: Partial<WorkspaceState> }
  | { t: "error"; e: string | null };

function mergeMessages(cur: MessageDTO[], add: MessageDTO[]): MessageDTO[] {
  const byId = new Map(cur.map((m) => [m.id, m]));
  for (const m of add) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
}

function upsert<T extends { id: string }>(list: T[], item: T, prepend = false): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return prepend ? [item, ...list] : [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}

function reducer(s: WorkspaceState, a: Action): WorkspaceState {
  switch (a.t) {
    case "reset":
      return initial;
    case "loaded":
      return { ...s, ...a.s, loaded: true, error: null };
    case "patch":
      return { ...s, ...a.s };
    case "messages":
      return { ...s, messages: mergeMessages(s.messages, a.m), hasMore: a.hasMore ?? s.hasMore };
    case "agent":
      return { ...s, agents: upsert(s.agents, a.a) };
    case "task":
      return { ...s, tasks: upsert(s.tasks, a.task, true).sort((x, y) => y.number - x.number) };
    case "dispatch":
      return { ...s, dispatches: { ...s.dispatches, [a.d.id]: a.d } };
    case "runEvent": {
      const cur = s.runEvents[a.e.dispatchId] ?? [];
      if (cur.some((x) => x.seq === a.e.seq)) return s;
      return { ...s, runEvents: { ...s.runEvents, [a.e.dispatchId]: [...cur, a.e].sort((x, y) => x.seq - y.seq) } };
    }
    case "runEvents":
      return { ...s, runEvents: { ...s.runEvents, [a.id]: a.e } };
    case "approval":
      return { ...s, approvals: { ...s.approvals, [a.a.id]: a.a } };
    case "memory":
      if ("deleted" in a.m) {
        const id = a.m.id;
        return { ...s, memory: s.memory.filter((m) => m.id !== id) };
      }
      return { ...s, memory: upsert(s.memory, a.m, true) };
    case "presence":
      return { ...s, members: s.members.map((m) => (m.userId === a.userId ? { ...m, online: a.online } : m)) };
    case "error":
      return { ...s, error: a.e };
  }
}

/** One Socket.IO connection for the signed-in user. */
export function createSocket(): Socket<ServerToClientEvents, any> {
  return io({ transports: ["websocket"], reconnectionDelayMax: 10_000 });
}

/**
 * Loads and live-updates one project. On every (re)connect it re-joins the room and fetches
 * anything missed since the newest message it has, so a dropped connection never loses messages.
 */
export function useWorkspace(projectId: string | null, socket: Socket<ServerToClientEvents, any> | null) {
  const [state, dispatch] = useReducer(reducer, initial);
  const latestSeq = useRef<string | null>(null);
  latestSeq.current = state.messages.at(-1)?.seq ?? latestSeq.current;

  const reloadSide = useCallback(async () => {
    if (!projectId) return;
    const [agents, tasks, memory, ds, hs, aps] = await Promise.all([
      get(`/api/projects/${projectId}/agents`),
      get(`/api/projects/${projectId}/tasks`),
      get(`/api/projects/${projectId}/memory`),
      get(`/api/projects/${projectId}/dispatches`),
      get(`/api/projects/${projectId}/handoffs`),
      get(`/api/projects/${projectId}/approvals`),
    ]);
    dispatch({
      t: "patch",
      s: {
        agents: agents.agents,
        tasks: tasks.tasks,
        memory: memory.entries,
        dispatches: Object.fromEntries((ds.dispatches as DispatchDTO[]).map((d) => [d.id, d])),
        handoffs: hs.handoffs,
        approvals: Object.fromEntries((aps.approvals as ApprovalDTO[]).map((x) => [x.id, x])),
      },
    });
  }, [projectId]);

  const reloadMembers = useCallback(async () => {
    if (!projectId) return;
    const p = await get(`/api/projects/${projectId}`);
    dispatch({ t: "patch", s: { project: p.project, members: p.members } });
  }, [projectId]);

  useEffect(() => {
    dispatch({ t: "reset" });
    latestSeq.current = null;
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const [p, msgs] = await Promise.all([get(`/api/projects/${projectId}`), get(`/api/projects/${projectId}/messages?limit=60`)]);
        if (cancelled) return;
        dispatch({ t: "loaded", s: { project: p.project, members: p.members, messages: msgs.messages, hasMore: msgs.hasMore } });
        await reloadSide();
      } catch (e) {
        if (!cancelled) dispatch({ t: "error", e: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadSide]);

  useEffect(() => {
    if (!socket || !projectId) return;
    const join = async () => {
      const r = await socket.emitWithAck("room:join", { projectId });
      if (!r.ok) return dispatch({ t: "error", e: r.error ?? "Could not join the room" });
      // Catch up on anything sent while disconnected.
      if (latestSeq.current) {
        let after = latestSeq.current;
        for (let i = 0; i < 20; i++) {
          const page = await get(`/api/projects/${projectId}/messages?after=${after}&limit=200`);
          dispatch({ t: "messages", m: page.messages });
          if (!page.hasMore || !page.messages.length) break;
          after = page.messages.at(-1).seq;
        }
        await Promise.all([reloadSide(), reloadMembers()]);
      }
    };
    const onMsg = (m: MessageDTO) => m.projectId === projectId && dispatch({ t: "messages", m: [m] });
    const onAgent = (a: AgentDTO) => a.projectId === projectId && dispatch({ t: "agent", a });
    const onTask = (task: TaskDTO) => {
      if (task.projectId !== projectId) return;
      dispatch({ t: "task", task });
      void get(`/api/projects/${projectId}/handoffs`).then((h) => dispatch({ t: "patch", s: { handoffs: h.handoffs } }));
    };
    const onDispatch = (d: DispatchDTO) => d.projectId === projectId && dispatch({ t: "dispatch", d });
    const onRun = (e: RunEventDTO) => dispatch({ t: "runEvent", e });
    const onMemory = (m: MemoryDTO | { id: string; deleted: true }) => dispatch({ t: "memory", m });
    const onPresence = (p: { userId: string; online: boolean }) => dispatch({ t: "presence", ...p });
    const onApproval = (x: ApprovalDTO) => x.projectId === projectId && dispatch({ t: "approval", a: x });
    socket.on("connect", join);
    socket.on("message:new", onMsg);
    socket.on("agent:updated", onAgent);
    socket.on("task:updated", onTask);
    socket.on("dispatch:updated", onDispatch);
    socket.on("run:event", onRun);
    socket.on("memory:updated", onMemory);
    socket.on("presence:updated", onPresence);
    socket.on("approval:updated", onApproval);
    if (socket.connected) void join();
    return () => {
      socket.off("connect", join);
      socket.off("message:new", onMsg);
      socket.off("agent:updated", onAgent);
      socket.off("task:updated", onTask);
      socket.off("dispatch:updated", onDispatch);
      socket.off("run:event", onRun);
      socket.off("memory:updated", onMemory);
      socket.off("presence:updated", onPresence);
      socket.off("approval:updated", onApproval);
      socket.emit("room:leave", { projectId });
    };
  }, [socket, projectId, reloadSide, reloadMembers]);

  const loadOlder = useCallback(async () => {
    if (!projectId || !state.messages.length) return;
    const page = await get(`/api/projects/${projectId}/messages?limit=60&before=${state.messages[0]!.seq}`);
    dispatch({ t: "messages", m: page.messages, hasMore: page.hasMore });
  }, [projectId, state.messages]);

  const loadRunEvents = useCallback(async (dispatchId: string) => {
    const r = await get(`/api/dispatches/${dispatchId}/events`);
    dispatch({ t: "runEvents", id: dispatchId, e: r.events });
    dispatch({ t: "dispatch", d: r.dispatch });
  }, []);

  const addMessages = useCallback((m: MessageDTO[]) => dispatch({ t: "messages", m }), []);
  const upsertTask = useCallback((task: TaskDTO) => dispatch({ t: "task", task }), []);
  const upsertAgent = useCallback((a: AgentDTO) => dispatch({ t: "agent", a }), []);
  const upsertApproval = useCallback((a: ApprovalDTO) => dispatch({ t: "approval", a }), []);

  return { state, loadOlder, loadRunEvents, addMessages, upsertTask, upsertAgent, upsertApproval, reloadSide, reloadMembers };
}

/** Tracks the socket's connection state for the banner. */
export function useConnection(socket: Socket | null): Conn {
  const [conn, set] = useReducer((_: Conn, c: Conn) => c, "connecting");
  useEffect(() => {
    if (!socket) return;
    const on = () => set("online");
    const off = () => set("reconnecting");
    const err = () => set(socket.active ? "reconnecting" : "offline");
    socket.on("connect", on);
    socket.on("disconnect", off);
    socket.on("connect_error", err);
    if (socket.connected) set("online");
    return () => {
      socket.off("connect", on);
      socket.off("disconnect", off);
      socket.off("connect_error", err);
    };
  }, [socket]);
  return conn;
}

export type Workspace = ReturnType<typeof useWorkspace>;
