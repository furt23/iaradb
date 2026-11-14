/** Workspace, catalog and history (see iara.workspaces, iara.kernel.catalog). */

export interface TableRef {
  /** the display name: `orders` (default catalog, main), `sales.orders`, or `sales.main.orders` (another catalog) */
  name: string;
  /** relative to the workspace root when inside it */
  path: string;
  format: "parquet" | "delta" | "csv" | "json";
  /** the catalog's name (absent: the default catalog) */
  catalog?: string;
  /** `catalog.schema.table`, lowercased: the name grants use */
  full: string;
}

export interface ColumnStats {
  column: string;
  min: unknown;
  max: unknown;
  nulls: number;
  /** false when only part of the files or row groups had statistics */
  exact: boolean;
}

export interface TableInfo extends TableRef {
  /** `nullable: false` is NOT NULL, when the table's schema says */
  columns: { name: string; type: string; nullable?: boolean }[];
  /** null: not counted (only parquet and Delta tables keep a count without being read whole) */
  num_rows: number | null;
  files: number;
  bytes: number;
  /** Delta tables: the version, partition columns and COMMENT of the log */
  version?: number | null;
  partitions?: string[];
  description?: string | null;
  stats: ColumnStats[];
}

/** One commit of a Delta table (`catalog.history`), newest first; metric and parameter values are text. */
export interface DeltaCommit {
  version: number;
  /** milliseconds since the epoch */
  timestamp: number;
  operation: string | null;
  operation_parameters: Record<string, string>;
  operation_metrics: Record<string, string>;
  engine_info: string | null;
}

export interface KernelInfo {
  protocol: number;
  version: string;
  pid: number;
  /** machine the kernel runs on */
  host?: string;
  platform?: string;
  root: string;
  name: string;
  tables: TableRef[];
  /** `main` first (absent from older kernels) */
  schemas?: string[];
  /** the default catalog first, then the others by name (absent from older kernels) */
  catalogs?: string[];
}

/** A table a run read: `table` is its `catalog.schema.table` name when the catalog has one at `location`. */
export interface TableRead {
  table: string | null;
  /** the table's folder, file pattern or URL, as the engine was given it */
  location: string;
  /** the Delta version read or written (null: not a Delta table) */
  version: number | null;
}

/** A table a run wrote. */
export interface TableWrite extends TableRead {
  /** the Delta operation (`WRITE`, `MERGE`, ...) or the statement */
  operation: string;
}

/** One run the kernel reports to the Studio (the `history` event): a SQL statement, or a Python cell that read or wrote tables. */
export interface HistoryEntry {
  /** unix seconds */
  ts: number;
  kind: "sql" | "python";
  /** the statement, or the Python cell's code */
  query: string;
  source: string;
  elapsed_ms: number;
  rows: number | null;
  error: string | null;
  /** the parameter values of a parameterized query */
  params?: Record<string, unknown>;
  memory_peak: number | null;
  spilled_bytes: number | null;
  requests: { list: number; head: number; get: number; bytes: number } | null;
  reads: TableRead[];
  writes: TableWrite[];
}
