/** Workspace, catalog and history (see workhouse.workspaces, workhouse.kernel.catalog). */

export interface TableRef {
  name: string;
  /** relative to the workspace root when inside it */
  path: string;
  format: "parquet" | "csv";
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
  columns: { name: string; type: string }[];
  num_rows: number;
  files: number;
  bytes: number;
  stats: ColumnStats[];
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
}

export interface HistoryEntry {
  /** unix seconds */
  ts: number;
  query: string;
  source: string;
  elapsed_ms: number;
  rows: number | null;
  error: string | null;
}
