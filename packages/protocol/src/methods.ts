/**
 * The kernel's method table and events (see workhouse.kernel.session and
 * workhouse.kernel.protocol). Each method maps to `[params, result]`.
 */

import type { Completions, Diagnostic, SignatureHelp } from "./assist";
import type { Cell, CellKind, CellOutput, CellState, NotebookView, RunResult, Variable } from "./notebook";
import type { ExplainResult, QueryProfile } from "./query";
import type { ResultPage, SortKey } from "./results";
import type { HistoryEntry, KernelInfo, TableInfo, TableRef } from "./workspace";

type Empty = Record<string, never>;

/** A notebook's source, written by the Studio (`persist: false`). */
export interface NotebookSource {
  path: string;
  source: string;
}

export interface KernelMethods {
  ping: [Empty, KernelInfo];
  "workspace.info": [Empty, KernelInfo];
  "workspace.reload": [Empty, KernelInfo];
  /** the catalog from the Studio's workhouse.toml text (null: none) */
  "workspace.configure": [{ toml: string | null }, KernelInfo];
  /** `source`: the notebook's file content (else the kernel reads its own file) */
  "notebook.open": [{ path: string; source?: string }, NotebookView];
  /** `persist: false`: the kernel does not write the file, the Studio writes `source` */
  "notebook.create": [{ path: string; persist?: boolean }, NotebookView & { source: string }];
  "notebook.view": [Empty, NotebookView];
  /** the open notebook's file moved: same state under the new path */
  "notebook.rename": [{ path: string }, NotebookView];
  "notebook.save": [{ cells: Cell[]; persist?: boolean }, NotebookSource];
  "notebook.run": [{ cells: Cell[]; cell_ids: string[] | null }, RunResult];
  "notebook.variables": [Empty, Variable[]];
  /** null when a newer request for the same cell superseded this one */
  "assist.complete": [{ code: string; cursor: number; cell_id: string }, Completions | null];
  "assist.signature": [{ code: string; cursor: number; cell_id: string }, SignatureHelp | null];
  "assist.lint": [{ code: string; kind: CellKind; cell_id: string }, Diagnostic[] | null];
  interrupt: [Empty, { interrupted: boolean }];
  "result.page": [{ result_id: string; offset: number; limit: number; sort?: SortKey[] }, ResultPage];
  "result.export": [{ result_id: string; format: "csv" | "parquet"; name?: string }, { path: string }];
  /** a chunk of an exported file (base64): downloads from remote kernels */
  "file.read": [{ path: string; offset?: number; length?: number }, { data: string; size: number; eof: boolean }];
  "catalog.list": [Empty, TableRef[]];
  "catalog.table": [{ name: string }, TableInfo];
  /** columns of every table, for editor completion */
  "catalog.schema": [Empty, Record<string, { name: string; type: string }[]>];
  "catalog.preview": [{ name: string; limit?: number }, CellOutput];
  /** `entry`: the table's workhouse.toml section (the Studio appends it when `persist: false`) */
  "catalog.add": [{ name: string; path: string; format?: "parquet" | "csv"; persist?: boolean }, TableRef & { entry: string }];
  "sql.run": [{ query: string; source?: string }, CellOutput];
  "sql.explain": [{ query: string }, ExplainResult];
  "history.list": [{ limit?: number }, HistoryEntry[]];
  shutdown: [Empty, { ok: boolean }];
}

export type KernelMethod = keyof KernelMethods;
export type ParamsOf<M extends KernelMethod> = KernelMethods[M][0];
export type ResultOf<M extends KernelMethod> = KernelMethods[M][1];

export interface CellStateEvent extends CellState {
  cell_id: string;
}

export interface CellStreamEvent {
  cell_id: string;
  stream: "stdout" | "stderr";
  text: string;
}

export interface ProgressEvent {
  cell_id?: string;
  queries: QueryProfile[];
}

export interface KernelEvents {
  "kernel.ready": KernelInfo;
  "cell.state": CellStateEvent;
  "cell.stream": CellStreamEvent;
  progress: ProgressEvent;
}

export type KernelEventName = keyof KernelEvents;

export type KernelEvent = {
  [E in KernelEventName]: { event: E; data: KernelEvents[E] };
}[KernelEventName];

/** Wire messages from the kernel. */
export type KernelMessage =
  | { id: number; result: unknown }
  | { id: number | null; error: { type: string; message: string } }
  | { event: KernelEventName; request: number | null; data: unknown };
