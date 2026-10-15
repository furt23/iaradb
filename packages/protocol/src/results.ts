/** Tabular results, served page by page (see workhouse.kernel.runtime.results). */

export interface ColumnInfo {
  name: string;
  /** Arrow type name, e.g. `int64`, `string_view`, `decimal128(15, 2)` */
  type: string;
}

/**
 * Values are JSON-safe: integers beyond 2^53, decimals, dates, timestamps and
 * binary values arrive as strings; NaN / Infinity as the strings "nan" / "inf".
 */
export type CellValue = string | number | boolean | null | CellValue[] | { [key: string]: CellValue };

export interface ResultPage {
  offset: number;
  total: number;
  rows: CellValue[][];
}

export interface ResultMeta {
  id: string;
  columns: ColumnInfo[];
  num_rows: number;
  /** a large result the kernel keeps on disk (memory-mapped) instead of in memory */
  on_disk?: boolean;
  /** a preview: `num_rows` are the first rows; downloads, charts and the wrangler read all of them */
  truncated?: boolean;
  /** how many rows there are in all, when known (a lazy query's preview does not count them) */
  total_rows?: number | null;
  /** the first page */
  page: ResultPage;
}

export type ChartKind = "bar" | "line" | "area" | "scatter" | "histogram";
export type ChartAgg = "sum" | "avg" | "count" | "min" | "max" | "none";

/** What to draw from a result (saved with the cell or query that made it). */
export interface ChartSpec {
  kind: ChartKind;
  /** the category / axis column (the measured column of a histogram) */
  x: string;
  /** value columns (none when counting rows) */
  y: string[];
  agg: ChartAgg;
  /** a column that splits the values into series */
  group?: string | null;
  /** histogram buckets */
  bins?: number;
}

/** The points of a chart, aggregated or sampled by the kernel. */
export interface ChartData {
  columns: string[];
  rows: CellValue[][];
  /** more categories or points than were sent */
  truncated: boolean;
}

export interface SortKey {
  column: string;
  descending?: boolean;
}
