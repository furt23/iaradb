/** Notebook editor state: cells being edited plus what the kernel reports (pure). */

import type { Cell, CellKind, CellState, CellStateEvent, CellStreamEvent, NotebookView, ProgressEvent, QueryProfile } from "@workhouse/protocol";

/** The run in progress: what the kernel queued and what already finished. */
export interface RunProgress {
  startedAt: number;
  queued: string[];
  /** cells that started running in this run */
  started: Record<string, true>;
  /** elapsed ms of the cells that finished in this run */
  finished: Record<string, number>;
  failed: number;
}

export interface RunSummary {
  startedAt: number;
  finishedAt: number;
  /** cells that ran */
  cells: number;
  /** sum of their run times */
  computeMs: number;
  failed: number;
}

export interface NotebookState {
  path: string;
  cells: Cell[];
  states: Record<string, CellState>;
  /** code of each cell's last run (to tell stale cells) */
  runCode: Record<string, string>;
  progress: Record<string, QueryProfile[]>;
  dirty: boolean;
  running: boolean;
  current: RunProgress | null;
  lastRun: RunSummary | null;
}

export type NotebookAction =
  | { type: "edit"; id: string; patch: Partial<Pick<Cell, "code" | "kind" | "output" | "config">> }
  | { type: "add"; index: number; cell: Cell }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; delta: -1 | 1 }
  | { type: "reorder"; id: string; over: string }
  | { type: "saved" }
  | { type: "run"; cells: Cell[]; at: number }
  | { type: "finished"; at: number }
  | { type: "reset" }
  | { type: "cell.state"; data: CellStateEvent }
  | { type: "cell.stream"; data: CellStreamEvent }
  | { type: "progress"; data: ProgressEvent };

export const IDLE: CellState = { status: "idle", stale: false, output: null, streams: [], elapsed_ms: null };

const STALE_MARK = "\u0000stale";

export function initialState(view: NotebookView): NotebookState {
  const runCode: Record<string, string> = {};
  for (const c of view.cells) {
    const s = view.states[c.id];
    if (s && (s.status === "done" || s.status === "error")) runCode[c.id] = s.stale ? STALE_MARK : c.code;
  }
  return { path: view.path, cells: view.cells, states: view.states, runCode, progress: {}, dirty: false, running: false, current: null, lastRun: null };
}

/** Sum of every cell's last run time (what the cells show). */
export function totalElapsed(state: NotebookState): number {
  return state.cells.reduce((sum, c) => sum + (state.states[c.id]?.elapsed_ms ?? 0), 0);
}

/** `cells` with the cell `id` moved to the position of `over`. */
export function reorder(cells: Cell[], id: string, over: string): Cell[] {
  const from = cells.findIndex((c) => c.id === id);
  const to = cells.findIndex((c) => c.id === over);
  if (from < 0 || to < 0 || from === to) return cells;
  const out = [...cells];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

const FINAL = new Set(["done", "error", "cancelled"]);

/** Follow the run in progress through a cell's state change. */
function track(run: RunProgress | null, data: CellStateEvent): RunProgress | null {
  if (!run) return run;
  const id = data.cell_id;
  if (data.status === "queued" && !run.queued.includes(id)) return { ...run, queued: [...run.queued, id] };
  if (data.status === "running") return { ...run, started: { ...run.started, [id]: true } };
  if (!FINAL.has(data.status) || !run.queued.includes(id) || id in run.finished) return run;
  // cells un-queued by an interrupt come back in their previous state: not run
  const ran = id in run.started;
  if (!ran && data.status !== "error") return run;
  return {
    ...run,
    finished: { ...run.finished, [id]: ran ? (data.elapsed_ms ?? 0) : 0 },
    failed: run.failed + (data.status === "error" ? 1 : 0),
  };
}

function summarize(run: RunProgress, at: number): RunSummary {
  const times = Object.entries(run.finished).filter(([id]) => id in run.started);
  return { startedAt: run.startedAt, finishedAt: at, cells: times.length, computeMs: times.reduce((s, [, ms]) => s + ms, 0), failed: run.failed };
}

export function isStale(state: NotebookState, cell: Cell): boolean {
  const s = state.states[cell.id];
  return !!s && (s.status === "done" || s.status === "error") && state.runCode[cell.id] !== cell.code;
}

export function newCellId(): string {
  return Math.random().toString(16).slice(2, 12).padEnd(10, "0");
}

/** An unused `df_<n>` name for a new SQL cell's result. */
export function nextResultName(cells: Cell[]): string {
  const used = new Set(cells.map((c) => c.output).filter(Boolean));
  for (let i = 1; ; i++) if (!used.has(`df_${i}`)) return `df_${i}`;
}

export function makeCell(kind: CellKind, cells: Cell[]): Cell {
  return { id: newCellId(), kind, code: "", name: "_", output: kind === "sql" ? nextResultName(cells) : null, config: {}, setup: false };
}

function updateCell(state: NotebookState, id: string, patch: Partial<Cell>): NotebookState {
  return { ...state, dirty: true, cells: state.cells.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

export function notebookReducer(state: NotebookState, action: NotebookAction): NotebookState {
  switch (action.type) {
    case "edit":
      return updateCell(state, action.id, action.patch);
    case "add": {
      const cells = [...state.cells];
      cells.splice(action.index, 0, action.cell);
      return { ...state, cells, dirty: true };
    }
    case "remove":
      return { ...state, cells: state.cells.filter((c) => c.id !== action.id), dirty: true };
    case "move": {
      const i = state.cells.findIndex((c) => c.id === action.id);
      const j = i + action.delta;
      if (i < 0 || j < 0 || j >= state.cells.length) return state;
      const cells = [...state.cells];
      [cells[i], cells[j]] = [cells[j], cells[i]];
      return { ...state, cells, dirty: true };
    }
    case "reorder": {
      const cells = reorder(state.cells, action.id, action.over);
      return cells === state.cells ? state : { ...state, cells, dirty: true };
    }
    case "saved":
      return { ...state, dirty: false };
    case "run": {
      const runCode = { ...state.runCode };
      for (const c of action.cells) runCode[`pending:${c.id}`] = c.code;
      const current: RunProgress = { startedAt: action.at, queued: [], started: {}, finished: {}, failed: 0 };
      return { ...state, running: true, runCode, current };
    }
    case "finished": {
      const lastRun = state.current ? summarize(state.current, action.at) : state.lastRun;
      return { ...state, running: false, progress: {}, current: null, lastRun };
    }
    case "reset":
      return { ...state, running: false, progress: {}, runCode: {}, states: {}, current: null, lastRun: null };
    case "cell.state": {
      const { cell_id, ...cellState } = action.data;
      const runCode = { ...state.runCode };
      if (cellState.status === "done" || cellState.status === "error" || cellState.status === "cancelled") {
        const sent = runCode[`pending:${cell_id}`];
        if (sent !== undefined) runCode[cell_id] = sent;
      }
      const progress = cellState.status === "running" ? state.progress : omit(state.progress, cell_id);
      return { ...state, runCode, progress, current: track(state.current, action.data), states: { ...state.states, [cell_id]: cellState } };
    }
    case "cell.stream": {
      const { cell_id, stream, text } = action.data;
      const prev = state.states[cell_id] ?? IDLE;
      const streams = [...prev.streams];
      const last = streams[streams.length - 1];
      if (last && last.stream === stream) streams[streams.length - 1] = { stream, text: last.text + text };
      else streams.push({ stream, text });
      return { ...state, states: { ...state.states, [cell_id]: { ...prev, streams } } };
    }
    case "progress": {
      const id = action.data.cell_id;
      return id ? { ...state, progress: { ...state.progress, [id]: action.data.queries } } : state;
    }
  }
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _, ...rest } = record;
  return rest;
}
