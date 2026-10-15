/** Notebook editor state: cells being edited plus what the kernel reports (pure). */

import type { Cell, CellKind, CellState, CellStateEvent, CellStreamEvent, NotebookView, ProgressEvent, QueryProfile, WidgetValue, WidgetsState } from "@workhouse/protocol";

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
  /** the widgets the cells defined (`workhouse.widgets.*`) and their values */
  widgets: WidgetsState;
}

export const NO_WIDGETS: WidgetsState = { definitions: [], values: {} };

export type NotebookAction =
  | { type: "edit"; id: string; patch: Partial<Pick<Cell, "code" | "kind" | "output" | "config">> }
  /** `index`: position among the visible cells (the setup cell is not one) */
  | { type: "add"; index: number; cell: Cell }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; delta: -1 | 1 }
  | { type: "reorder"; id: string; over: string }
  | { type: "saved" }
  | { type: "run"; cells: Cell[]; at: number }
  | { type: "finished"; at: number }
  | { type: "reset" }
  /** the kernel restarted: values are gone, outputs stay (shown as stale) */
  | { type: "restarted" }
  /** `cells: null`: every cell */
  | { type: "clearOutputs"; cells: string[] | null }
  | { type: "cell.state"; data: CellStateEvent }
  | { type: "cell.stream"; data: CellStreamEvent }
  | { type: "progress"; data: ProgressEvent }
  /** the kernel's widgets differ from the ones shown */
  | { type: "widgets.changed"; data: WidgetsState }
  /** a widget was edited: shown at once, before the kernel confirms it */
  | { type: "widget.value"; name: string; value: WidgetValue };

export const IDLE: CellState = { status: "idle", stale: false, output: null, streams: [], elapsed_ms: null };

const STALE_MARK = "\u0000stale";

export function initialState(view: NotebookView): NotebookState {
  const runCode: Record<string, string> = {};
  for (const c of view.cells) {
    const s = view.states[c.id];
    if (s && (s.status === "done" || s.status === "error")) runCode[c.id] = s.stale ? STALE_MARK : c.code;
  }
  return { path: view.path, cells: view.cells, states: view.states, runCode, progress: {}, dirty: false, running: false, current: null, lastRun: null, widgets: view.widgets ?? NO_WIDGETS };
}

/** The cells the notebook shows: the setup cell (`with app.setup:`) is edited from the Kernel menu instead. */
export function visibleCells(cells: Cell[]): Cell[] {
  return cells.some((c) => c.setup) ? cells.filter((c) => !c.setup) : cells;
}

export function setupCell(cells: Cell[]): Cell | undefined {
  return cells.find((c) => c.setup);
}

/** First line of the error the setup cell's last run ended with (null: it did not fail). */
export function setupError(state: NotebookState): string | null {
  const cell = setupCell(state.cells);
  const s = cell && state.states[cell.id];
  if (!s || s.status !== "error" || isStale(state, cell)) return null;
  const out = s.output;
  const text = out && out.type === "error" ? `${out.ename}: ${out.evalue}` : "it did not run";
  return text.split("\n", 1)[0].trim() || "it did not run";
}

/** Index in `cells` of the visible position `index`: after the visible cell before it, or before the first visible cell. */
export function fullIndex(cells: Cell[], index: number): number {
  const visible = visibleCells(cells);
  if (visible.length === cells.length) return Math.max(0, Math.min(index, cells.length));
  if (index <= 0) return visible.length ? cells.indexOf(visible[0]) : cells.length;
  if (index >= visible.length) return cells.length;
  return cells.indexOf(visible[index - 1]) + 1;
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

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A cell id: 8 characters of a-z and 0-9. Written in the notebook file, so it is also what a link to the cell names. */
export function newCellId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
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
      cells.splice(fullIndex(cells, action.index), 0, action.cell);
      return { ...state, cells, dirty: true };
    }
    case "remove":
      if (state.cells.find((c) => c.id === action.id)?.setup) return state;
      return { ...state, cells: state.cells.filter((c) => c.id !== action.id), dirty: true };
    case "move": {
      // the neighbour is the next visible cell: the setup cell never takes part
      const visible = visibleCells(state.cells);
      const vi = visible.findIndex((c) => c.id === action.id);
      const other = visible[vi + action.delta];
      if (vi < 0 || !other) return state;
      const i = state.cells.findIndex((c) => c.id === action.id);
      const j = state.cells.indexOf(other);
      const cells = [...state.cells];
      [cells[i], cells[j]] = [cells[j], cells[i]];
      return { ...state, cells, dirty: true };
    }
    case "reorder": {
      const involved = state.cells.filter((c) => c.id === action.id || c.id === action.over);
      const cells = involved.some((c) => c.setup) ? state.cells : reorder(state.cells, action.id, action.over);
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
    case "restarted": {
      const states: Record<string, CellState> = {};
      const runCode: Record<string, string> = {};
      for (const [id, s] of Object.entries(state.states)) {
        if (s.status !== "done" && s.status !== "error") continue;
        states[id] = { ...s, stale: true };
        runCode[id] = STALE_MARK;
      }
      return { ...state, running: false, progress: {}, runCode, states, current: null };
    }
    case "clearOutputs": {
      const states = { ...state.states };
      let progress = state.progress;
      for (const id of action.cells ?? state.cells.map((c) => c.id)) {
        const s = states[id];
        // queued and running cells keep their state: their output is still coming
        if (!s || s.status === "queued" || s.status === "running") continue;
        states[id] = IDLE;
        progress = omit(progress, id);
      }
      return { ...state, states, progress };
    }
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
    case "widgets.changed":
      return { ...state, widgets: action.data };
    case "widget.value":
      if (!state.widgets.definitions.some((d) => d.name === action.name)) return state;
      return { ...state, widgets: { ...state.widgets, values: { ...state.widgets.values, [action.name]: action.value } } };
  }
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _, ...rest } = record;
  return rest;
}
