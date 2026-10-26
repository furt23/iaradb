"use client";

import { useTheme } from "@mui/material/styles";
import type { Cell, CellKind, CellValue, CellOutput, CellState, ErrorOutput, Variable } from "@iara/protocol";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import type { IaraAdapter, IaraDecide } from "@/features/iara/types";
import { applyEdits } from "@/lib/iara/edits";
import type { ContextCell, IaraChange, IaraFileContext, IaraOutcome } from "@/lib/iara/protocol";

import { isStale, type NotebookState, visibleCells } from "./notebookState";
import { reveal } from "./useCellAnchor";
import type { useNotebook } from "./useNotebook";

// the limits of the request's schema (lib/iara/protocol.ts), which rejects a context beyond them
const MAX_CODE = 20_000;
const MAX_CELLS = 500;
const MAX_VARIABLES = 500;
/** what Iara hears of a cell's output in the context, and of the cell it just ran */
const CONTEXT_CHARS = 1500;
const OUTCOME_CHARS = 8000;
const MAX_ERROR = 4000;
const CONTEXT_ROWS = 5;
const OUTCOME_ROWS = 20;
const MAX_VALUE = 100;
/** how long to wait for a rendered change before giving up */
const RENDER_MS = 3000;

const ANSI = /\u001b\[[0-9;]*m/g;

/** `text` cut to its first `max` characters. */
export function clipHead(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** `text` cut to its last `max` characters (what a log or a long print ends with matters most). */
export function clipTail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-Math.max(0, max - 1))}`;
}

/** A result value on one line of a TSV. */
function cellText(v: CellValue): string {
  const s = v === null ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return clipHead(s.replace(/\s+/g, " "), MAX_VALUE);
}

function tsv(columns: string[], rows: CellValue[][]): string {
  return [columns.map((c) => c.replace(/\s+/g, " ")), ...rows.map((r) => r.map(cellText))].map((r) => r.join("\t")).join("\n");
}

/** What an output says in text, at most `chars` long: a table is its size, columns and first `rows` rows. */
export function summarizeOutput(output: CellOutput, rows: number, chars: number): string {
  switch (output.type) {
    case "text":
    case "markdown":
      return clipTail(output.text, chars);
    case "html":
      return "[html]";
    case "image":
      return "[image]";
    case "error":
      return clipHead(`${output.ename}: ${output.evalue}`, chars);
    case "table": {
      const r = output.result;
      const size = `${r.total_rows ?? r.num_rows}${r.truncated && r.total_rows == null ? "+" : ""} rows`;
      const columns = r.columns.map((c) => `${c.name} (${c.type})`).join(", ");
      const names = r.columns.map((c) => c.name);
      return clipHead(`${size}, columns: ${columns}\n${tsv(names, r.page.rows.slice(0, rows))}`, chars);
    }
    case "tables": {
      const share = Math.floor(chars / Math.max(1, output.tables.length));
      return output.tables.map((o, i) => `${o.name ?? `preview ${i + 1}`}: ${summarizeOutput(o, rows, share)}`).join("\n\n");
    }
  }
}

/** The text a cell printed (stdout and stderr), its end. */
function printed(s: CellState, chars: number): string {
  return clipTail(s.streams.map((c) => c.text).join("").trim(), chars);
}

/** What a cell printed and its output, in text, at most `chars` long (a third of it for what it printed). */
export function summarizeCell(s: CellState | undefined, chars: number, rows: number): string | undefined {
  if (!s) return undefined;
  const text = printed(s, Math.floor(chars / 3));
  const shown = s.output ? summarizeOutput(s.output, rows, chars - (text ? text.length + 1 : 0)) : "";
  return [text, shown].filter(Boolean).join("\n") || undefined;
}

/** The error of a run, with the end of its traceback. */
function errorText(o: ErrorOutput): string {
  const head = clipHead(`${o.ename}: ${o.evalue}`, 1000);
  const trace = o.traceback.replace(ANSI, "").trim();
  return trace ? `${head}\n${clipTail(trace, MAX_ERROR - head.length - 1)}` : head;
}

/** How the notebook's last run left a cell, for Iara: ok, error, stale (edited or restarted since), or idle (not run). */
export function cellStatus(state: NotebookState, cell: Cell): ContextCell["status"] {
  if (isStale(state, cell)) return "stale";
  const status = state.states[cell.id]?.status;
  return status === "done" ? "ok" : status === "error" ? "error" : "idle";
}

function contextCell(state: NotebookState, cell: Cell): ContextCell {
  return {
    id: cell.id,
    kind: cell.kind,
    name: cell.setup ? "setup" : cell.name === "_" ? undefined : clipHead(cell.name, 128),
    code: cell.code.slice(0, MAX_CODE),
    // a markdown cell's output is its own text
    output: cell.kind === "markdown" ? undefined : summarizeCell(state.states[cell.id], CONTEXT_CHARS, CONTEXT_ROWS),
    status: cellStatus(state, cell),
    ...(cell.setup && { setup: true }),
  };
}

/** The notebook as Iara sees it: every cell (the setup one too) with its status and a summary of its output, and the variables. `canRun`: whether its cluster runs. */
export function notebookContext(state: NotebookState, variables: Variable[], selectedCellId: string | null, canRun: boolean): IaraFileContext {
  const cells = state.cells.slice(0, MAX_CELLS).map((c) => contextCell(state, c));
  return {
    surface: "notebook",
    path: state.path.slice(0, 1024),
    cells,
    selectedCellId: cells.some((c) => c.id === selectedCellId) ? selectedCellId : null,
    variables: variables.slice(0, MAX_VARIABLES).map((v) => ({ name: clipHead(v.name, 256), type: clipHead(v.type, 256), summary: clipHead(v.summary, 512) })),
    canRun,
  };
}

/** What a cell did in the run that just ended. */
export function runOutcome(state: NotebookState, cellId: string): IaraOutcome {
  const s = state.states[cellId];
  const base = { applied: true, cellId, ran: true } as const;
  if (s?.status === "done") return { ...base, status: "ok", output: summarizeCell(s, OUTCOME_CHARS, OUTCOME_ROWS) };
  const error =
    s?.status === "error" ? (s.output?.type === "error" ? errorText(s.output) : "The cell did not run.") : s?.status === "cancelled" ? "The run was stopped." : "The cell did not finish.";
  return { ...base, status: "error", output: (s && printed(s, OUTCOME_CHARS)) || undefined, error };
}

/** Resolves once `done` holds (false when `ms` pass first): waits for React to render what a change dispatched. */
export async function waitFor(done: () => boolean, ms = RENDER_MS): Promise<boolean> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

type Notebook = ReturnType<typeof useNotebook>;
type NotebookChange = Extract<IaraChange, { action: "insert_cell" | "edit_cell" }>;

/** A change Iara proposes, shown in the notebook until the user keeps or undoes it: the code it writes (as the user adjusts it) against the cell's. */
export interface NotebookReview {
  change: NotebookChange;
  /** edit: the edited cell; insert: the cell the new one goes after (null: at the end) */
  cellId: string | null;
  kind: CellKind;
  /** the cell's code now; "" for a new cell */
  original: string;
  code: string;
  setCode(code: string): void;
  decide: IaraDecide;
}

/** The notebook as the last render left it (the state and the commands read through here are never older than that render). */
type Live = RefObject<{ nb: Notebook; variables: Variable[]; review: NotebookReview | null; show(cellId: string): void }>;

/** The code a change writes: as the user adjusted it in its preview, else as Iara wrote it. Throws when the edits no longer fit the cell. */
function changeCode(live: Live, change: NotebookChange): string {
  const { nb, review } = live.current;
  if (review?.change === change) return review.code;
  if (change.action === "insert_cell") return change.code;
  const cell = nb.state.cells.find((c) => c.id === change.cellId);
  if (!cell) throw new Error("There is no cell with that id.");
  if (cell.setup) throw new Error("The setup cell cannot be edited.");
  return applyEdits(cell.code, change.edits);
}

/** Adds or edits the cell a change names, with `code`, and waits for it to render; its id. `clear` takes the preview away in the same render. */
async function showChange(live: Live, change: NotebookChange, code: string, clear: () => void): Promise<string> {
  const { nb } = live.current;
  const cells = nb.state.cells;
  let id: string;
  if (change.action === "insert_cell") {
    const after = change.afterCellId;
    if (after && !cells.some((c) => c.id === after)) throw new Error("There is no cell with that id.");
    const visible = visibleCells(cells);
    clear();
    id = nb.addCell(after ? visible.findIndex((c) => c.id === after) + 1 : visible.length, change.kind).id;
  } else {
    if (!cells.some((c) => c.id === change.cellId)) throw new Error("There is no cell with that id.");
    id = change.cellId;
    clear();
  }
  nb.edit(id, { code });
  // `nb.run` sends the cells of the last render: the edit has to be in it
  if (!(await waitFor(() => live.current.nb.state.cells.find((c) => c.id === id)?.code === code))) throw new Error("The change did not show up in the notebook.");
  live.current.show(id);
  return id;
}

async function runCell(live: Live, cellId: string): Promise<IaraOutcome> {
  const { nb } = live.current;
  if (!nb.state.cells.some((c) => c.id === cellId)) throw new Error("There is no cell with that id.");
  if (nb.state.running) throw new Error("A run is already going on in this notebook");
  const before = nb.state.lastRun;
  await nb.run([cellId]);
  // the run's end (a new `lastRun`) is in the state once it is rendered: only then the cell's final state is
  if (!(await waitFor(() => live.current.nb.state.lastRun !== before))) throw new Error("The run did not finish.");
  return runOutcome(live.current.nb.state, cellId);
}

/**
 * Shows the change Iara proposed as a review in the notebook (`setReview`) and
 * applies it once the user approved. Without a running cluster a change is made
 * but not run, and a cell is not run.
 */
export function notebookAdapter(live: Live, canRun: boolean, setReview: Dispatch<SetStateAction<NotebookReview | null>>): IaraAdapter {
  return {
    canRun,
    preview(change, decide) {
      if (change.action !== "insert_cell" && change.action !== "edit_cell") return () => {};
      const cells = live.current.nb.state.cells;
      let shown: Pick<NotebookReview, "cellId" | "kind" | "original" | "code">;
      if (change.action === "insert_cell") {
        const after = change.afterCellId;
        if (after && !cells.some((c) => c.id === after)) return () => {};
        shown = { cellId: after, kind: change.kind, original: "", code: change.code };
      } else {
        const cell = cells.find((c) => c.id === change.cellId);
        // the server never proposes it; an old or altered proposal must not touch the setup either
        if (!cell || cell.setup) return () => {};
        try {
          shown = { cellId: cell.id, kind: cell.kind, original: cell.code, code: applyEdits(cell.code, change.edits) };
        } catch {
          return () => {};
        }
      }
      setReview({ change, ...shown, setCode: (code) => setReview((r) => r && { ...r, code }), decide });
      return () => setReview((r) => (r?.change === change ? null : r));
    },
    async apply(change, run) {
      if (change.action === "edit_query") throw new Error("not possible in a notebook");
      if (change.action === "run_cell") return canRun ? runCell(live, change.cellId) : { applied: false, ran: false, error: "the cluster is not running" };
      const cellId = await showChange(live, change, changeCode(live, change), () => setReview(null));
      return run && canRun ? runCell(live, cellId) : { applied: true, cellId, ran: false };
    },
  };
}

/**
 * Iara's door into a notebook: the context it reads and the adapter that
 * applies its approved changes. Both read the editor through a ref set after
 * each render, so they see a change once it rendered. The notebook saves on its
 * own (autosave, and after each run).
 */
export function useNotebookIara({ nb, variables, rootRef, canRun }: { nb: Notebook; variables: Variable[]; rootRef: RefObject<HTMLElement | null>; canRun: boolean }) {
  const color = useTheme().palette.primary.main;
  const [review, setReview] = useState<NotebookReview | null>(null);
  const live: Live = useRef({ nb, variables, review, show: () => {} });
  useEffect(() => {
    live.current = {
      nb,
      variables,
      review,
      show: (id) => rootRef.current && reveal(rootRef.current, id, color),
    };
  });

  // the edited cell comes into view the way an applied change does
  const change = review?.change;
  useEffect(() => {
    if (change?.action === "edit_cell") live.current.show(change.cellId);
  }, [change]);

  // the cell the user last worked in: "this cell" in a message
  const selected = useRef<string | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    const onFocus = (e: FocusEvent) => {
      const id = (e.target as Element).closest?.("[data-cell-id]")?.getAttribute("data-cell-id");
      if (id) selected.current = id;
    };
    root?.addEventListener("focusin", onFocus);
    return () => root?.removeEventListener("focusin", onFocus);
  }, [rootRef]);

  const getContext = useCallback(() => notebookContext(live.current.nb.state, live.current.variables, selected.current, canRun), [canRun]);
  const adapter = useMemo(() => notebookAdapter(live, canRun, setReview), [canRun]);
  return { getContext, adapter, review };
}
