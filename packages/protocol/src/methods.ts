/**
 * The kernel's method table and events (see workhouse.kernel.session and
 * workhouse.kernel.protocol). Each method maps to `[params, result]`.
 */

import type { Completions, Diagnostic, SignatureHelp } from "./assist";
import type { Cell, CellKind, CellOutput, CellState, NotebookView, RunResult, Variable, WidgetValue, WidgetsState } from "./notebook";
import type { ExplainResult, QueryAnalysis, QueryParams, QueryProfile } from "./query";
import type { ChartData, ChartSpec, ResultPage, SortKey } from "./results";
import type { DeltaCommit, HistoryEntry, KernelInfo, TableInfo, TableRef } from "./workspace";

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
  /**
   * `source`: the notebook's file content (else the kernel reads its own file).
   * `widgets`: widget values to start from (a job's parameters; the values a restarted kernel lost)
   */
  "notebook.open": [{ path: string; source?: string; widgets?: Record<string, unknown> }, NotebookView];
  /** `persist: false`: the kernel does not write the file, the Studio writes `source` */
  "notebook.create": [{ path: string; persist?: boolean }, NotebookView & { source: string }];
  "notebook.view": [Empty, NotebookView];
  /** the open notebook's file moved: same state under the new path */
  "notebook.rename": [{ path: string }, NotebookView];
  "notebook.save": [{ cells: Cell[]; persist?: boolean }, NotebookSource];
  /** `cells: null` runs the notebook as opened (a job) */
  "notebook.run": [{ cells: Cell[] | null; cell_ids: string[] | null }, RunResult];
  /**
   * A widget got a value: the kernel coerces it to the widget's type, then runs the cells that read it
   * (and their descendants). `cells`: the editor's cells, adopted first
   */
  "widgets.set": [{ notebook?: string; name: string; value: WidgetValue; cells?: Cell[] | null }, RunResult];
  "notebook.variables": [Empty, Variable[]];
  /** `cells: null`: every cell. Their outputs go back to idle; values stay */
  "notebook.clear": [{ path: string; cells: string[] | null }, { cleared: number }];
  /** null when a newer request for the same cell superseded this one */
  "assist.complete": [{ code: string; cursor: number; cell_id: string }, Completions | null];
  "assist.signature": [{ code: string; cursor: number; cell_id: string }, SignatureHelp | null];
  "assist.lint": [{ code: string; kind: CellKind; cell_id: string }, Diagnostic[] | null];
  interrupt: [Empty, { interrupted: boolean }];
  "result.page": [{ result_id: string; offset: number; limit: number; sort?: SortKey[] }, ResultPage];
  "result.chart": [{ result_id: string; spec: ChartSpec }, ChartData];
  "result.export": [{ result_id: string; format: "csv" | "parquet"; name?: string }, { path: string }];
  /** a chunk of an exported file (base64): downloads from remote kernels */
  "file.read": [{ path: string; offset?: number; length?: number }, { data: string; size: number; eof: boolean }];
  "catalog.list": [Empty, TableRef[]];
  "catalog.table": [{ name: string }, TableInfo];
  /** columns of every table, for editor completion */
  "catalog.history": [{ table: string; limit?: number }, DeltaCommit[]];
  "catalog.schema": [Empty, Record<string, { name: string; type: string }[]>];
  "catalog.preview": [{ name: string; limit?: number }, CellOutput];
  /** `entry`: the table's workhouse.toml section (the Studio appends it when `persist: false`) */
  "catalog.add": [{ name: string; path: string; format?: "parquet" | "csv" | "json"; persist?: boolean }, TableRef & { entry: string }];
  "sql.run": [{ query: string; source?: string } & QueryParams, CellOutput];
  "sql.explain": [{ query: string } & QueryParams, ExplainResult];
  /** runs the query with profiling; the rows are counted, not returned */
  "sql.analyze": [{ query: string } & QueryParams, QueryAnalysis];
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

/**
 * A statement (`CREATE TABLE ... AS`, `DROP TABLE`) changed the catalog: the
 * table's new `workhouse.toml` section (null: it was dropped). The Studio,
 * which owns the file, applies it.
 */
export interface CatalogChange {
  /** the display name: `orders`, `tpch.lineitem`, or a schema's name */
  name: string;
  entry: string | null;
  /**
   * what `name` is: a table (the default) or a schema (`[schemas.<name>]`);
   * `refresh`: the schema's location has new data, workhouse.toml is unchanged
   */
  kind?: "table" | "schema" | "refresh";
}

export interface KernelEvents {
  "kernel.ready": KernelInfo;
  "cell.state": CellStateEvent;
  "cell.stream": CellStreamEvent;
  progress: ProgressEvent;
  "catalog.changed": CatalogChange;
  /** the widgets (definitions or values) differ from what the client last heard */
  "widgets.changed": WidgetsState;
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
