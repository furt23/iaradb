/** The Data Wrangler (see iara.kernel.wrangle): recipes run in the kernel. */

import type { CellValue, ColumnInfo } from "./results";

/** a catalog table, or a stored result of the kernel */
export type WrangleSource = { table: string } | { result_id: string };

export interface WrangleStep {
  id: string;
  label: string;
  enabled: boolean;
  op: { kind: string } & Record<string, unknown>;
}

export interface ColumnQuality {
  name: string;
  type: string;
  total: number;
  nulls: number;
  /** empty strings (text columns) */
  empty: number;
}

export interface WranglePreview {
  columns: ColumnInfo[];
  /** the first rows of the result */
  rows: CellValue[][];
  num_rows: number;
  quality: ColumnQuality[];
  /** the code that produces the result: the preview runs this SQL */
  sql: string;
  python: string;
}

export interface WrangleProfile {
  name: string;
  type: string;
  total: number;
  nulls: number;
  distinct: number;
  min?: CellValue;
  max?: CellValue;
  mean?: number | null;
  median?: number | null;
  std?: number | null;
  top: { value: string; count: number; share: number }[];
}
