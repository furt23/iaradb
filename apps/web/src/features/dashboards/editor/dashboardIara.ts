/** Iara's door into the dashboard editor: what she reads of it, and how an approved change reaches its files (pure but for `io`). */

import { joinQuery, splitQuery } from "@/features/queries/queryHeader";
import { modelAfter, type DashboardContext } from "@/lib/dashboards/iaraOps";
import type { Dashboard, LayoutItem, RenderResult, Widget } from "@/lib/dashboards/types";
import type { DashboardOp, IaraOutcome } from "@/lib/iara/protocol";

import { newLayoutItem } from "./newWidget";
import type { FoundColumns } from "./useDatasetColumns";

// the limits of the request's schema (lib/iara/protocol.ts), which rejects a context beyond them
const MAX_SQL = 20_000;
const MAX_WIDGET = 20_000;
const MAX_MODEL = 200_000;
const MAX_ITEMS = 300;
const MAX_COLUMNS = 1000;
const MAX_STATUS = 1000;
const MAX_OUTPUT = 8000;
const MAX_ERROR = 4000;

/** What a widget showed in the last render: "ok", or why it failed. */
function statusOf(result: RenderResult | null, id: string): string | undefined {
  const shown = result?.widgets[id];
  if (!shown) return undefined;
  return shown.kind === "error" ? `error: ${shown.message}`.slice(0, MAX_STATUS) : "ok";
}

/** The dashboard as Iara sees it. */
export function dashboardContext({ dashboard, model, found, view, selected, result }: { dashboard: Dashboard; model: string; found: FoundColumns; view: DashboardContext["view"]; selected: string | null; result: RenderResult | null }): DashboardContext {
  return {
    surface: "dashboard",
    path: `dashboards/${dashboard.slug}`.slice(0, 1024),
    title: dashboard.config.title.slice(0, 200),
    view,
    selectedWidgetId: selected,
    datasets: dashboard.datasets.slice(0, MAX_ITEMS).map((d) => {
      const columns = found[d.name];
      return { name: d.name, sql: d.sql.slice(0, MAX_SQL), ...(d.recipe && { recipe: true }), columns: Array.isArray(columns) ? columns.slice(0, MAX_COLUMNS).map(({ name, type }) => ({ name: name.slice(0, 256), type: type.slice(0, 256) })) : null };
    }),
    model: model.slice(0, MAX_MODEL),
    widgets: dashboard.widgets.slice(0, MAX_ITEMS).map((w) => {
      const status = statusOf(result, w.id);
      const { id, ...fields } = w;
      return { id, json: JSON.stringify(fields).slice(0, MAX_WIDGET), ...(status && { status }) };
    }),
    layout: dashboard.layout.slice(0, MAX_ITEMS).map(({ widget, x, y, w, h }) => ({ widget, x, y, w, h })),
  };
}

/** How the operations reach the dashboard's files; each throws with the reason when it cannot. */
export interface DashboardIo {
  saveDataset(name: string, text: string): Promise<void>;
  deleteDataset(name: string): Promise<void>;
  saveModel(source: string): Promise<void>;
  saveWidget(widget: Widget): Promise<void>;
  deleteWidget(id: string): Promise<void>;
  saveLayout(items: LayoutItem[]): Promise<void>;
  newId(): string;
}

/**
 * Applies the operations: datasets first, then the model, then the widgets and where they sit, since each can read what
 * came before. A failure stops there, and what was done stays done. The widgets it wrote or removed are the caller's to read back.
 */
export async function applyDashboardOps(ops: readonly DashboardOp[], now: Pick<Dashboard, "datasets" | "layout" | "model">, io: DashboardIo): Promise<void> {
  for (const op of ops) {
    if (op.op === "set_dataset") {
      // the header keeps what the query's placeholders ask for
      const params = now.datasets.find((d) => d.name === op.name)?.params ?? {};
      await io.saveDataset(op.name, joinQuery({ ...splitQuery(""), params, body: op.sql }));
    } else if (op.op === "remove_dataset") {
      await io.deleteDataset(op.name);
    }
  }
  const source = modelAfter(now.model, ops);
  if (source !== now.model) await io.saveModel(source);

  let layout = now.layout;
  for (const op of ops) {
    if (op.op === "set_widget") {
      const id = op.id ?? io.newId();
      const widget = { ...op.widget, id } as unknown as Widget;
      await io.saveWidget(widget);
      const place = op.place && { widget: id, ...op.place };
      if (place) layout = [...layout.filter((i) => i.widget !== id), place];
      else if (!layout.some((i) => i.widget === id)) layout = [...layout, newLayoutItem(layout, widget)];
    } else if (op.op === "remove_widget") {
      await io.deleteWidget(op.id);
      layout = layout.filter((i) => i.widget !== op.id);
    } else if (op.op === "move_widget") {
      const { id, x, y, w, h } = op;
      layout = layout.map((i) => (i.widget === id ? { widget: id, x, y, w, h } : i));
    }
  }
  if (layout !== now.layout) await io.saveLayout(layout);
}

/** How a change came out: the widgets as they draw now, an error when one that worked stopped working or a new one fails. */
export function outcomeOf(widgets: readonly Widget[], before: RenderResult | null, after: RenderResult): IaraOutcome {
  const name = (w: Widget) => `${(w.kind !== "text" && w.title) || w.kind} (${w.id})`;
  const lines = widgets.flatMap((w) => {
    const shown = after.widgets[w.id];
    if (!shown) return [];
    if (shown.kind === "error") return [`${name(w)}: ${shown.message}`];
    return [`${name(w)}: ${shown.kind === "chart" ? `${shown.data.rows.length} points` : shown.kind === "table" ? `${shown.total} rows` : "ok"}`];
  });
  const broke = widgets.filter((w) => after.widgets[w.id]?.kind === "error" && before?.widgets[w.id]?.kind !== "error");
  const base = { applied: true, ran: true, output: lines.join("\n").slice(0, MAX_OUTPUT) };
  if (!broke.length) return { ...base, status: "ok" };
  return { ...base, status: "error", error: broke.map((w) => `${name(w)} does not draw`).join("\n").slice(0, MAX_ERROR) };
}
