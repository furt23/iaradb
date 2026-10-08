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
  /** the first page */
  page: ResultPage;
}

export interface SortKey {
  column: string;
  descending?: boolean;
}
