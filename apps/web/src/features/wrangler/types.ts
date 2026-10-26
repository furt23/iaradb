/** Steps of a Data Wrangler recipe (run in the kernel: iara.kernel.wrangle). */

export type FilterOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_equal"
  | "less_than"
  | "less_equal"
  | "between"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "is_null"
  | "is_not_null";

export type FillNullStrategy = "constant" | "mean" | "median" | "mode";

export type TextCaseMode = "upper" | "lower" | "title";

export type CastTargetType = "int64" | "float64" | "utf8" | "bool" | "date" | "timestamp";

/** `count` without a column counts rows */
export type AggFn = "count" | "count_distinct" | "sum" | "avg" | "min" | "max" | "median";

export interface Aggregation {
  fn: AggFn;
  column?: string;
  /** the result column's name */
  as: string;
}

export type DatePart = "year" | "quarter" | "month" | "week" | "day" | "weekday";
export type DateUnit = "year" | "quarter" | "month" | "week" | "day";
export type JoinHow = "inner" | "left";
export type PivotAgg = "sum" | "count" | "avg" | "min" | "max";

export type WranglerOp =
  | { kind: "filter"; column: string; op: FilterOperator; value?: string | number; value2?: string | number }
  | { kind: "drop_columns"; columns: string[] }
  | { kind: "rename_column"; from: string; to: string }
  | { kind: "cast"; column: string; toType: CastTargetType }
  | { kind: "fill_null"; column: string; strategy: FillNullStrategy; value?: string | number }
  | { kind: "drop_nulls"; columns: string[] }
  | { kind: "text_case"; column: string; mode: TextCaseMode }
  | { kind: "text_trim"; column: string }
  | { kind: "text_replace"; column: string; pattern: string; replacement: string; isRegex?: boolean }
  | { kind: "split_column"; column: string; delimiter: string; numParts?: number }
  | { kind: "deduplicate"; subset?: string[] }
  | { kind: "sort"; column: string; descending: boolean }
  | { kind: "one_hot_encode"; column: string }
  | { kind: "math_round"; column: string; decimals: number }
  /** one row per distinct `keys` (none: one row), with the aggregations */
  | { kind: "group_by"; keys: string[]; aggs: Aggregation[] }
  /** adds `columns` of a catalog table where `on` pairs match (a name the result already has gets the table's name as prefix) */
  | { kind: "join"; table: string; how: JoinHow; on: { left: string; right: string }[]; columns: string[] }
  /** adds column `as`: a number (year, quarter, month, ISO week, day of month, weekday 0 = Sunday) */
  | { kind: "date_part"; column: string; part: DatePart; as: string }
  /** adds column `as`: the date (or timestamp) at the start of its `unit` */
  | { kind: "date_trunc"; column: string; unit: DateUnit; as: string }
  /** adds column `name`: a SQL expression over the current columns (no subqueries, no `;`) */
  | { kind: "calculated"; name: string; expression: string }
  /** one row per distinct `index`, one column per value of `column` holding `agg` of `value` */
  | { kind: "pivot"; index: string[]; column: string; value: string; agg: PivotAgg }
  /** each of `columns` becomes a row: its name in column `name`, its value in column `value` */
  | { kind: "unpivot"; columns: string[]; name: string; value: string };

export interface WranglerStep {
  id: string;
  op: WranglerOp;
  label: string;
  enabled: boolean;
}
