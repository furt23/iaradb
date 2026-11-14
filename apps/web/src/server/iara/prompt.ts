import "server-only";

import type { ContextCell, IaraFileContext } from "@/lib/iara/protocol";

import type { Step } from "./state";
import { cutToTokens } from "./tokens";

/** How notebook code reaches the catalog, for the agents that write or read it. */
export const NOTEBOOK_API = `Notebook Python cells: the notebook's setup already defines \`iara\` and \`ws\` (the workspace: the same catalog SQL sees). Never redefine them, and never read a catalog table from its files.
- \`ws.table("main.orders")\` is a catalog table as a LazyFrame.
- \`ws.sql("SELECT ...")\` runs SQL over the catalog and returns a LazyFrame; frames passed as keyword arguments are tables by that name: \`ws.sql("SELECT * FROM t", t=lf)\`.
- \`from iara import functions as F\`, then \`F.col("x")\`, \`F.lit(1)\`; \`lf.filter(...)\`, \`.select(...)\`, \`.with_columns(...)\`, \`.group_by("a").agg(F.col("x").sum().alias("total"), F.col("id").n_unique().alias("n"))\`, \`.join(other, on="k", how="inner")\` (or left_on/right_on), \`.sort("total", descending=True)\`, \`.limit(10)\`, \`.collect()\`.
- A cell's last expression is its output; a frame shows as a table.
Notebook SQL cells run on the same catalog with no setup.`;

/** How a dashboard is made, for the agents that write or read one. */
export const DASHBOARD_API = `A dashboard is made of datasets, a model and widgets. Change it with operations, applied together once the user approves:
- set_dataset {name, sql}: adds a dataset, or replaces the query of the one of that name. name is lowercase letters, digits and _. sql is one read-only query with table names in full. A dataset that holds a whole table is SELECT * FROM catalog.schema.table.
- remove_dataset {name}.
- add_model_lines {lines} and edit_model {edits}: the model, one statement per line, with datasets by name.
  relate(orders.o_custkey, customer.c_custkey) relates two datasets: the first is the many side, the second has one row per value. A chart reaches a column going from the dataset of its values to the one side, however many steps.
  revenue = sum(orders.o_totalprice) is a measure. Aggregations: sum, avg, min, max, count, count_distinct, count_rows(dataset). divide(a, b) is a safe division. calculate(m, filters), all_(dataset or dataset.column), ytd, previous_year, running_total, rolling, rank work too. measure(expression, format="currency", currency="BRL", decimals=2) sets a number format (format: number, currency, percent; compact=True).
  dates = calendar(orders.o_orderdate) makes a calendar dataset with date, year, quarter, month, week, month_of_year, day_of_week.
- set_widget {id, widget, place}: id null adds a widget, an id replaces that one. place {x, y, w, h} is optional: 12 columns, rows of 32 px.
- remove_widget {id}. move_widget {id, x, y, w, h}.

Widgets:
- Chart: {"kind":"chart","title":"...","dataset":"orders","spec":{"kind":"bar","x":"customer.c_mktsegment","y":[],"agg":"sum","group":null},"values":[{"name":"Receita","dataset":"orders","column":"o_totalprice","agg":"sum"}],"measures":["revenue"],"sort":"value","top":10,"style":{"look":"hbar"}}
  spec.kind is bar, line, area, pie or counter (a counter has x ""). spec.x and spec.group are the category and the legend: a column of dataset by its name, of another dataset as dataset.column. spec.y stays [] and spec.agg "sum".
  values are columns aggregated on the chart, from any dataset (agg: sum, avg, count, count_distinct, min, max; no column counts rows; format is optional, {"style":"currency","currency":"BRL","decimals":2}). measures are names of the model. A chart needs at least one of them. Prefer values unless a measure exists or the calculation needs one.
  sort: x, x_desc, value, value_asc. top: only the first categories.
  style.look draws the same data differently. On bar: stacked, percent, hbar, hbar_stacked, hbar_percent, combo, waterfall, heatmap, matrix. On area: area_stacked. On pie: donut, treemap, funnel. On counter: gauge.
  Other style keys: palette (ocean, sunset, forest, berry, earth, mono), colors {"series or category": "#rrggbb"}, legend (top, bottom, left, right, none), gridlines, smooth, x_title, y_title, labels, format, series {"name":{"axis":"right","as":"line"}}.
  Raw points: spec.kind scatter (spec.x and spec.y numeric columns of dataset, agg "none") and histogram (spec.x, agg "count", bins).
- Table: {"kind":"table","title":"...","dataset":"orders","columns":["o_orderkey","customer.c_name"]}. columns is optional; a related dataset's column is dataset.column.
- Filter: {"kind":"filter","title":"...","control":"select","fields":[{"dataset":"customer","column":"c_mktsegment"}],"value_type":"text"}. control is select, multi, date_range or text. A filter on a dataset narrows those that point at it.
- Text: {"kind":"text","markdown":"## Title"}.
Use only tables and columns you have seen. To use a table as a dataset, describe it first, and relate it to the others in the same change when a chart needs it.`;

const cellText =(c: ContextCell, selected: boolean): string => {
  const head = [`cell ${c.id}`, c.kind, c.name && `"${c.name}"`, c.setup && "read-only", c.status && `status ${c.status}`, selected && "selected"].filter(Boolean).join(", ");
  return [`[${head}]`, c.code, c.output && `output: ${c.output}`].filter(Boolean).join("\n");
};

/** The open file as prompt text: for a notebook its cells in order (id, kind, name, code, output summary, status), the selected cell and the variables; for the SQL editor the query and its last result. Cut to `max` tokens. */
export async function contextText(ctx: IaraFileContext, max = 30_000): Promise<string> {
  if (ctx.surface === "agent") return "";
  const text =
    ctx.surface === "dashboard"
      ? dashboardText(ctx)
      : ctx.surface === "sql"
      ? [`SQL editor ${ctx.path}`, `query:\n${ctx.query || "(empty)"}`, ctx.result && `last result:\n${ctx.result}`]
      : [
          `Notebook ${ctx.path}`,
          ctx.canRun === false && "Its cluster is not running: cells cannot run now. Propose changes with run false and say the user can run them once the cluster is started.",
          ctx.cells.length ? ctx.cells.map((c) => cellText(c, c.id === ctx.selectedCellId)).join("\n\n") : "(no cells)",
          ctx.variables.length && `variables:\n${ctx.variables.map((v) => `${v.name}: ${v.type}${v.summary ? ` = ${v.summary}` : ""}`).join("\n")}`,
        ];
  return cutToTokens(text.filter(Boolean).join("\n\n"), max);
}

function dashboardText(ctx: Extract<IaraFileContext, { surface: "dashboard" }>): string[] {
  const dataset = (d: (typeof ctx.datasets)[number]) => {
    const columns = d.columns ? d.columns.map((c) => `${c.name} ${c.type}`).join(", ") : "columns not read yet";
    return [`dataset ${d.name}${d.recipe ? " (made of cleaning steps; its query cannot be rewritten)" : ""}`, `columns: ${columns}`, d.sql && `query:\n${d.sql}`].filter(Boolean).join("\n");
  };
  return [
    `Dashboard "${ctx.title}" (${ctx.path}), the user is on its ${ctx.view} tab`,
    ctx.selectedWidgetId && `selected widget: ${ctx.selectedWidgetId}`,
    ctx.datasets.length ? ctx.datasets.map(dataset).join("\n\n") : "(no datasets)",
    `model:\n${ctx.model || "(empty)"}`,
    ctx.widgets.length ? `widgets:\n${ctx.widgets.map((w) => `${w.id}${w.status ? ` [${w.status}]` : ""}: ${w.json}`).join("\n")}` : "(no widgets)",
    ctx.layout.length > 0 && `layout:\n${ctx.layout.map((i) => `${i.widget}: x ${i.x}, y ${i.y}, w ${i.w}, h ${i.h}`).join("\n")}`,
  ].filter((part): part is string => !!part);
}

/** A function call's result for the history. */
export function resultStep(call: { id: string; name: string }, result: string, isError = false): Step {
  return { type: "function_result", call_id: call.id, name: call.name, result, ...(isError && { is_error: true }) };
}

export function userStep(text: string): Step {
  return { type: "user_input", content: [{ type: "text", text }] };
}
