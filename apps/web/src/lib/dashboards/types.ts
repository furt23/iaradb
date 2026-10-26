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
}

/** a chart over a dataset; `spec.kind` "counter" is a single number, "pie" a pie */
export interface ChartWidget {
  id: string;
  kind: "chart";
  title?: string;
  dataset: string;
  spec: ChartSpec;
}

/** the first rows of a dataset */
export interface TableWidget {
  id: string;
  kind: "table";
  title?: string;
  dataset: string;
  /** the columns shown, in order (absent: all) */
  columns?: string[];
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
