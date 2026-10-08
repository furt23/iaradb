/**
 * Open notebooks as tabs in up to four panes (pure). A notebook is open in
 * at most one pane: each has a single editor state.
 */

import { isWithin, movedPath } from "@/lib/paths";

export type Arrangement = "columns" | "rows" | "grid";

export interface Pane {
  id: string;
  /** notebook paths, in tab order */
  tabs: string[];
  active: string | null;
}

export interface WorkbenchState {
  panes: Pane[];
  focused: string;
  arrangement: Arrangement;
}

export const MAX_PANES = 4;

export type WorkbenchAction =
  /** open (or show) a notebook, in the focused pane unless it is open elsewhere */
  | { type: "open"; path: string }
  /** open a notebook in a new pane (or the next one, when there are four) */
  | { type: "openToSide"; path: string }
  | { type: "activate"; pane: string; path: string }
  | { type: "close"; pane: string; path: string }
  /** close a notebook wherever it is open (it was deleted) */
  | { type: "closePath"; path: string }
  /** a file or folder was deleted: close every notebook at or under `path` */
  | { type: "closeWithin"; path: string }
  /** a file or folder moved: its open notebooks follow */
  | { type: "rename"; from: string; to: string }
  | { type: "closeOthers"; pane: string; path: string }
  | { type: "focus"; pane: string }
  /** a new, empty pane next to `pane` */
  | { type: "split"; pane: string }
  /** close a pane; its tabs join the neighbouring pane */
  | { type: "closePane"; pane: string }
  | { type: "moveTab"; path: string; to: string | "new" }
  | { type: "reorderTab"; pane: string; path: string; over: string }
  | { type: "arrange"; arrangement: Arrangement };

export function emptyWorkbench(): WorkbenchState {
  return { panes: [{ id: "p1", tabs: [], active: null }], focused: "p1", arrangement: "columns" };
}

export function paneOf(state: WorkbenchState, path: string): Pane | undefined {
  return state.panes.find((p) => p.tabs.includes(path));
}

export function focusedPane(state: WorkbenchState): Pane {
  return state.panes.find((p) => p.id === state.focused) ?? state.panes[0];
}

/** The notebook the URL shows: the focused pane's active tab. */
export function activePath(state: WorkbenchState): string | null {
  return focusedPane(state).active;
}

/** Every open notebook. */
export function openPaths(state: WorkbenchState): string[] {
  return state.panes.flatMap((p) => p.tabs);
}

function newPaneId(state: WorkbenchState): string {
  const used = new Set(state.panes.map((p) => p.id));
  for (let i = 1; ; i++) if (!used.has(`p${i}`)) return `p${i}`;
}

function withPane(state: WorkbenchState, id: string, f: (p: Pane) => Pane): WorkbenchState {
  return { ...state, panes: state.panes.map((p) => (p.id === id ? f(p) : p)) };
}

function insertAfterActive(p: Pane, path: string): Pane {
  const at = p.active ? p.tabs.indexOf(p.active) + 1 : p.tabs.length;
  const tabs = [...p.tabs];
  tabs.splice(at, 0, path);
  return { ...p, tabs, active: path };
}

function withoutTab(p: Pane, path: string): Pane {
  const i = p.tabs.indexOf(path);
  if (i < 0) return p;
  const tabs = p.tabs.filter((t) => t !== path);
  const active = p.active === path ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : p.active;
  return { ...p, tabs, active };
}

/** Remove pane `id` once its last tab is gone (keeping one pane), fixing the focus. */
function dropIfEmpty(state: WorkbenchState, id: string): WorkbenchState {
  const i = state.panes.findIndex((p) => p.id === id);
  if (i < 0 || state.panes[i].tabs.length > 0 || state.panes.length <= 1) return state;
  const focused = state.focused === id ? (state.panes[i - 1] ?? state.panes[i + 1]).id : state.focused;
  return { ...state, panes: state.panes.filter((p) => p.id !== id), focused };
}

function close(state: WorkbenchState, pane: string, path: string): WorkbenchState {
  return dropIfEmpty(withPane(state, pane, (p) => withoutTab(p, path)), pane);
}

function addPane(state: WorkbenchState, after: string, pane: Pane): WorkbenchState {
  const i = state.panes.findIndex((p) => p.id === after);
  const panes = [...state.panes];
  panes.splice(i + 1, 0, pane);
  return { ...state, panes, focused: pane.id };
}

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  switch (action.type) {
    case "open": {
      const at = paneOf(state, action.path);
      if (at) return { ...withPane(state, at.id, (p) => ({ ...p, active: action.path })), focused: at.id };
      return withPane(state, focusedPane(state).id, (p) => insertAfterActive(p, action.path));
    }
    case "openToSide": {
      const from = paneOf(state, action.path);
      const base = from ? close(state, from.id, action.path) : state;
      if (base.panes.length < MAX_PANES) {
        const after = from && base.panes.some((p) => p.id === from.id) ? from.id : base.focused;
        return addPane(base, after, { id: newPaneId(base), tabs: [action.path], active: action.path });
      }
      const i = base.panes.findIndex((p) => p.id === base.focused);
      const target = base.panes[(i + 1) % base.panes.length];
      return { ...withPane(base, target.id, (p) => insertAfterActive(p, action.path)), focused: target.id };
    }
    case "activate":
      return { ...withPane(state, action.pane, (p) => (p.tabs.includes(action.path) ? { ...p, active: action.path } : p)), focused: action.pane };
    case "close":
      return close(state, action.pane, action.path);
    case "closePath": {
      const at = paneOf(state, action.path);
      return at ? close(state, at.id, action.path) : state;
    }
    case "closeWithin":
      return state.panes
        .flatMap((p) => p.tabs.filter((t) => isWithin(t, action.path)).map((t) => [p.id, t] as const))
        .reduce((s, [pane, path]) => close(s, pane, path), state);
    case "rename": {
      const move = (t: string) => movedPath(t, action.from, action.to) ?? t;
      return { ...state, panes: state.panes.map((p) => ({ ...p, tabs: p.tabs.map(move), active: p.active && move(p.active) })) };
    }
    case "closeOthers":
      return withPane(state, action.pane, (p) => (p.tabs.includes(action.path) ? { ...p, tabs: [action.path], active: action.path } : p));
    case "focus":
      return state.panes.some((p) => p.id === action.pane) ? { ...state, focused: action.pane } : state;
    case "split":
      if (state.panes.length >= MAX_PANES) return state;
      return addPane(state, action.pane, { id: newPaneId(state), tabs: [], active: null });
    case "closePane": {
      if (state.panes.length <= 1) return state;
      const i = state.panes.findIndex((p) => p.id === action.pane);
      if (i < 0) return state;
      const closing = state.panes[i];
      const into = state.panes[i > 0 ? i - 1 : 1];
      const merged = withPane(state, into.id, (p) => {
        const tabs = [...p.tabs, ...closing.tabs.filter((t) => !p.tabs.includes(t))];
        return { ...p, tabs, active: p.active ?? closing.active };
      });
      return { ...merged, panes: merged.panes.filter((p) => p.id !== closing.id), focused: into.id };
    }
    case "moveTab": {
      const from = paneOf(state, action.path);
      if (!from || from.id === action.to) return state;
      if (action.to === "new") return workbenchReducer(state, { type: "openToSide", path: action.path });
      if (!state.panes.some((p) => p.id === action.to)) return state;
      const moved = withPane(withPane(state, from.id, (p) => withoutTab(p, action.path)), action.to, (p) => insertAfterActive(p, action.path));
      return dropIfEmpty({ ...moved, focused: action.to }, from.id);
    }
    case "reorderTab":
      return withPane(state, action.pane, (p) => {
        const from = p.tabs.indexOf(action.path);
        const to = p.tabs.indexOf(action.over);
        if (from < 0 || to < 0 || from === to) return p;
        const tabs = [...p.tabs];
        tabs.splice(to, 0, ...tabs.splice(from, 1));
        return { ...p, tabs };
      });
    case "arrange":
      return { ...state, arrangement: action.arrangement };
  }
}

/** A stored workbench, if it is well-formed. */
export function parseWorkbench(value: unknown): WorkbenchState | null {
  const v = value as Partial<WorkbenchState> | null;
  if (!v || !Array.isArray(v.panes) || v.panes.length < 1 || v.panes.length > MAX_PANES) return null;
  const seen = new Set<string>();
  const panes: Pane[] = [];
  for (const p of v.panes as Partial<Pane>[]) {
    if (typeof p?.id !== "string" || !Array.isArray(p.tabs)) return null;
    const tabs: string[] = [];
    for (const t of p.tabs) {
      if (typeof t === "string" && !seen.has(t)) {
        seen.add(t);
        tabs.push(t);
      }
    }
    panes.push({ id: p.id, tabs, active: typeof p.active === "string" && tabs.includes(p.active) ? p.active : (tabs[0] ?? null) });
  }
  const arrangement = v.arrangement === "rows" || v.arrangement === "grid" ? v.arrangement : "columns";
  const focused = panes.some((p) => p.id === v.focused) ? (v.focused as string) : panes[0].id;
  return { panes, focused, arrangement };
}
