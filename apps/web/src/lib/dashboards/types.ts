/**
 * Dashboards: a folder of the workspace, one file per domain, so each part
 * (data, visuals, layout) can be edited, reviewed and generated on its own.
 *
 *     dashboards/<slug>/
 *       dashboard.toml        DashboardConfig
 *       datasets/<name>.sql   Dataset: one query, `-- iara:params` header as in saved queries
 *       datasets/<name>.recipe.json   Dataset as a Recipe: Data Wrangler steps over a table, compiled to SQL by the kernel
 *       widgets/<id>.json     ChartWidget | TableWidget | FilterWidget
 *       widgets/<id>.md       TextWidget (the file is the markdown)
 *       layout.json           LayoutItem[]
 *
 * A published dashboard is a compiled copy in the Studio's data folder
 * (`PublishedDashboard`): drafts never reach viewers.
 */

import type { CellValue, ChartData, ChartSpec, ColumnInfo, QueryParamType, WrangleStep } from "@iara/protocol";

import type { ParamSpecs } from "@/features/queries/queryHeader";

/** `dashboard.toml` */
export interface DashboardConfig {
  /** stable across renames of the folder: names the published copy, its kernel and `/view/<id>` */
  id: string;
  title: string;
  description?: string;
  /** the cluster its queries run on (absent: the default cluster) */
  cluster?: string;
  /** how long rendered data is reused, in minutes */
  refresh_minutes: number;
  /** `[schedule]`: when the published dashboard is rendered again for its viewers */
  schedule?: RefreshSchedule;
}

export interface RefreshSchedule {
  /** cron, UTC */
  cron: string;
  enabled: boolean;
}

/** `datasets/<name>.recipe.json`: Data Wrangler steps over a catalog table (no code). */
export interface Recipe {
  source: { table: string };
  steps: WrangleStep[];
}

/** `datasets/<name>.sql` (one read-only query) or `datasets/<name>.recipe.json`. */
export interface Dataset {
  name: string;
  /** the query, without its header lines; a recipe's is what the kernel compiles it to ("" until then) */
  sql: string;
  /** its `:name` placeholders (header `-- iara:params`) */
  params: ParamSpecs;
  recipe?: Recipe;
  /**
   * "live": every render runs the query. Absent: the published dashboard reads
   * a stored copy of the result (an extract) that refreshes rebuild; a dataset
   * with params of its own is always live (a param changes the query).
   * Stored as the header line `-- iara:mode live`, or `"mode": "live"` in a recipe.
   */
  mode?: "live";
}

/** how numbers are written (Intl.NumberFormat in the viewer's language); a percent of 0.25 is 25% */
export interface NumberFormat {
  style: "number" | "currency" | "percent";
  /** digits after the decimal point (absent: up to 2) */
  decimals?: number;
  /** ISO 4217 code; required by "currency" */
  currency?: string;
  /** 1.2K, 3.4M */
  compact?: boolean;
}

/** a tint of conditional formatting: the status colors, and blue to highlight */
export type Tone = "green" | "amber" | "orange" | "red" | "blue";

export interface ColorRule {
  op: ">" | ">=" | "<" | "<=" | "=" | "!=";
  /** numbers compare as numbers; >, <… need a number on both sides (text never matches them) */
  value: number | string;
  tone: Tone;
}

/** how a table column is shown */
export interface ColumnFormat {
  number?: NumberFormat;
  /** the first rule a cell matches tints it (rules win over the scale) */
  rules?: ColorRule[];
  /**
   * Tints numeric cells by where they sit between the lowest and highest value
   * of the shown rows: `high` grows from none to full; with `low`, `low` fades
   * out toward the middle and `high` grows from there.
   */
  scale?: { high: Tone; low?: Tone };
}

/** a value column of a bar, line or area chart without a group */
export interface SeriesStyle {
  /** drawn against the right axis */
  axis?: "right";
  /** drawn as bars or as a line whatever the chart's kind (a combo chart) */
  as?: "bar" | "line";
}

/** how a chart is drawn, on top of what its spec asks the kernel for */
export interface ChartStyle {
  /** by value column */
  series?: Record<string, SeriesStyle>;
  /** the value next to each bar, point or slice */
  labels?: boolean;
  /** the left axis and its series (counters and pies too) */
  format?: NumberFormat;
  /** the right axis and its series */
  right_format?: NumberFormat;
}

/** a chart over a dataset; `spec.kind` "counter" is a single number, "pie" a pie */
export interface ChartWidget {
  id: string;
  kind: "chart";
  title?: string;
  dataset: string;
  spec: ChartSpec;
  style?: ChartStyle;
}

/** the first rows of a dataset */
export interface TableWidget {
  id: string;
  kind: "table";
  title?: string;
  dataset: string;
  /** the columns shown, in order (absent: all) */
  columns?: string[];
  /** by column name */
  formats?: Record<string, ColumnFormat>;
}

/** markdown */
export interface TextWidget {
  id: string;
  kind: "text";
  markdown: string;
}

export type FilterControl = "select" | "multi" | "date_range" | "text";

/** a column of a dataset a field filter narrows */
export interface FilterField {
  dataset: string;
  column: string;
}

/**
 * A filter narrows datasets either by their columns (`fields`: no SQL needed)
 * or by a `:name` placeholder they declare (`param`). Exactly one of the two.
 */
export interface FilterWidget {
  id: string;
  kind: "filter";
  title?: string;
  control: FilterControl;
  fields?: FilterField[];
  /** how values of a field filter are typed (picked from the column's type when it is chosen) */
  value_type?: Exclude<QueryParamType, "boolean" | "select">;
  param?: string;
}

export type Widget = ChartWidget | TableWidget | TextWidget | FilterWidget;
export type WidgetKind = Widget["kind"];

/** where a widget sits on the 12-column grid (`h` in rows of the grid) */
export interface LayoutItem {
  widget: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Dashboard {
  slug: string;
  config: DashboardConfig;
  datasets: Dataset[];
  widgets: Widget[];
  layout: LayoutItem[];
  /** files of the folder that could not be read, with why (the rest still loads) */
  problems: { file: string; error: string }[];
}

export interface DashboardSummary {
  slug: string;
  id: string;
  title: string;
  description?: string;
  /** unix milliseconds of the newest file of the folder */
  updatedAt: number;
  publishedAt: number | null;
}

/** what a filter holds: one value, several, or a range of ISO dates */
export type FilterValue = string | number | boolean | string[] | { from?: string; to?: string };

/** filter values by filter widget id */
export type FilterValues = Record<string, FilterValue>;

/** an x value a viewer clicked in a chart, as the kernel sent it (null: a missing value) */
export type PickValue = string | number | boolean | null;

/**
 * A category picked in a chart widget (bar, line, area, pie): every other chart
 * and table on the chart's dataset narrows to the rows whose `x` equals it.
 * Picks live in the viewer's page, like filter values, and are never saved.
 */
export interface CrossPick {
  widget: string;
  value: PickValue;
}

/** at most one pick per chart widget; the picks of several charts apply together */
export type CrossPicks = CrossPick[];

/** what a widget draws, from the kernel; errors are per widget */
export type WidgetData =
  | { kind: "chart"; data: ChartData; columns: ColumnInfo[] }
  | { kind: "table"; columns: ColumnInfo[]; rows: CellValue[][]; total: number }
  | { kind: "filter"; options: CellValue[] }
  | { kind: "error"; message: string };

export interface RenderResult {
  /** by widget id; text widgets have none */
  widgets: Record<string, WidgetData>;
  /** unix milliseconds the data was read */
  at: number;
}

/** who may open a published dashboard: every viewer of the team, or these emails */
export type Share = { kind: "team" } | { kind: "emails"; emails: string[] };

export interface PublishedDashboard {
  id: string;
  slug: string;
  title: string;
  description?: string;
  cluster?: string;
  refresh_minutes: number;
  datasets: Dataset[];
  widgets: Widget[];
  layout: LayoutItem[];
  share: Share;
  publishedBy: string;
  publishedAt: number;
}

/**
 * What a viewer's browser receives: no SQL. Param filters carry the spec of
 * their placeholder (type, options, default) so the input can be drawn.
 */
export interface ViewDashboard {
  id: string;
  title: string;
  description?: string;
  widgets: Widget[];
  layout: LayoutItem[];
  params: ParamSpecs;
  publishedAt: number;
}
