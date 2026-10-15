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
  | { kind: "math_round"; column: string; decimals: number };

export interface WranglerStep {
  id: string;
  op: WranglerOp;
  label: string;
  enabled: boolean;
}
