/**
 * The kernel's method table and events (see iara.kernel.session and
 * iara.kernel.protocol). Each method maps to `[params, result]`.
 */

import type { Completions, Diagnostic, SignatureHelp } from "./assist";
import type { Cell, CellKind, CellOutput, CellState, NotebookView, RunResult, Variable, WidgetValue, WidgetsState } from "./notebook";
import type { ExplainResult, QueryAnalysis, QueryParams, QueryProfile } from "./query";
import type { ChartData, ChartSpec, ColumnInfo, ResultPage, SortKey } from "./results";
import type { DeltaCommit, HistoryEntry, KernelInfo, TableInfo, TableRef } from "./workspace";
import type { WranglePreview, WrangleProfile, WrangleSource, WrangleStep } from "./wrangle";

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
  /** the Studio's catalog as iara.toml text (null: none) */
  "workspace.configure": [{ toml: string | null }, KernelInfo];
  /**
   * `source`: the notebook's file content (else the kernel reads its own file).
   * `widgets`: widget values to start from (a job's parameters; the values a restarted kernel lost)
   */
  "notebook.open": [{ path: string; source?: string; widgets?: Record<string, unknown> }, NotebookView];
  /** `persist: false`: the kernel does not write the file, the Studio writes `source` */
  "notebook.create": [{ path: string; persist?: boolean }, NotebookView & { source: string }];
  "notebook.view": [Empty, NotebookView];
  "notebook.parse": [{ path: string; source: string }, { cells: Cell[] }];
  "notebook.render": [{ path: string; source: string; cells: Cell[] }, { source: string }];
  "notebook.template": [{ path: string }, { source: string }];
  /** the open notebook's file moved: same state under the new path */
  "notebook.rename": [{ path: string }, NotebookView];
  "notebook.save": [{ cells: Cell[]; persist?: boolean }, NotebookSource];
  /** `cells: null` runs the notebook as opened (a job) */
  /** `autorun`: dependents of the run cells run too (else they turn stale) */
  "notebook.run": [{ cells: Cell[] | null; cell_ids: string[] | null; autorun?: boolean }, RunResult];
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
  /** the same rows as a base64 Arrow IPC stream (`rows`: how many it holds, fewer than asked past 16 MiB) */
  "result.arrow": [{ result_id: string; offset: number; limit: number; sort?: SortKey[] }, { offset: number; total: number; rows: number; data: string }];
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
  /** `entry`: the table's catalog section (the Studio appends it when `persist: false`) */
  "catalog.add": [{ name: string; path: string; format?: "parquet" | "csv" | "json"; persist?: boolean }, TableRef & { entry: string }];
  /** `allow`: the tables the query may read (`*`, `c`, `c.s` or `c.s.t`); absent: unchecked. Under it, files and writes are refused. */
  "sql.run": [{ query: string; source?: string; allow?: string[] } & QueryParams, CellOutput];
  "sql.explain": [{ query: string; allow?: string[] } & QueryParams, ExplainResult];
  /**
   * A dashboard dataset's result written as one zstd Parquet file at `path` (a
   * folder path or `s3://` URL), read under `allow`. `sources`: the catalog tables
   * it read (`catalog.schema.table`). Over `max_bytes` it fails and leaves no file.
   */
  "extract.write": [
    { query: string; path: string; allow: string[]; max_bytes: number; source?: string },
    { rows: number; bytes: number; columns: ColumnInfo[]; sources: string[] },
  ];
  /** runs the query with profiling; the rows are counted, not returned */
  "sql.analyze": [{ query: string } & QueryParams, QueryAnalysis];
  "history.list": [{ limit?: number }, HistoryEntry[]];
  /** a Data Wrangler recipe over a table or result: first rows, counts over all rows, its code */
  "wrangle.preview": [{ source: WrangleSource; steps: WrangleStep[] }, WranglePreview];
  "wrangle.profile": [{ source: WrangleSource; steps: WrangleStep[]; column: string }, WrangleProfile];
  /** only the SQL a recipe compiles to (nothing runs): what a dashboard's recipe dataset queries */
  "wrangle.sql": [{ source: WrangleSource; steps: WrangleStep[] }, { sql: string }];
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
 * A statement (`CREATE TABLE ... AS`, `DROP TABLE`, `CREATE CATALOG`, ...) changed
 * the catalog: the new section of what it names (null: it was dropped). The
 * Studio, which owns the file, applies it.
 */
export interface CatalogChange {
  /**
   * the display name: `orders` or `tpch.lineitem` (default catalog), `sales.main.orders`
   * (another catalog: always `catalog.schema.table`), a schema's name (`tpch`, or
   * `sales.raw` in another catalog), or a catalog's name (`sales`)
   */
  name: string;
  /**
   * the section: a table's `[tables.<name>]` (`[catalogs.<c>.tables.<name>]` in another
   * catalog), a schema's `[schemas.<name>]` (`[catalogs.<c>.schemas.<name>]`), or a
   * catalog's `[catalogs.<c>]` with its description. Dropping a catalog also drops
   * every `[catalogs.<c>.…]` section.
   */
  entry: string | null;
  /**
   * what `name` is: a table (the default), a schema or a catalog;
   * `refresh`: the schema's location has new data, the catalog is unchanged
   */
  kind?: "table" | "schema" | "catalog" | "refresh";
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
