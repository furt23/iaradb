import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// no theme and no language without the app around the components
vi.mock("@/features/results/chart/echarts/palette", async (actual) => ({
  ...(await actual<object>()),
  useChartColors: () => ({ series: ["#2a78d6", "#eb6834"], text: "#111111", muted: "#666666", grid: "#dddddd", surface: "#ffffff" }),
}));
vi.mock("@/lib/dashboards/numberFormat", async (actual) => ({ ...(await actual<object>()), numberLocale: () => "en-US" }));

import { MatrixView } from "../canvas/MatrixView";
import { WidgetBody } from "../canvas/WidgetBody";
import type { ChartWidget, TableWidget, WidgetData } from "@/lib/dashboards/types";
import { parseWidget, widgetJson } from "@/lib/dashboards/widgets";

import { ChartStyleSettings, colorItems } from "./ChartStyleSettings";
import { CHART_LOOKS } from "./chartLooks";
import { FieldWells } from "./FieldWells";
import { MeasureList } from "./MeasureList";
import { ModelContext } from "./useModel";
import { VisualGallery } from "./VisualGallery";
import { WidgetPanel } from "./WidgetPanel";

const datasets = [
  { name: "orders", sql: "", params: {} },
  { name: "customer", sql: "", params: {} },
];
const found = {
  orders: [
    { name: "status", type: "string" },
    { name: "total", type: "double" },
  ],
  customer: [{ name: "segment", type: "string" }],
};
const chart = (extra: Partial<ChartWidget> = {}): ChartWidget => ({
  id: "c",
  kind: "chart",
  dataset: "orders",
  spec: { kind: "bar", x: "customer.segment", y: [], agg: "sum", group: "status" },
  values: [{ name: "Sum of total", dataset: "orders", column: "total", agg: "sum" }],
  ...extra,
});
const data: WidgetData = {
  kind: "chart",
  columns: [],
  data: {
    columns: ["customer.segment", "status", "Sum of total"],
    rows: [
      ["BUILDING", "O", 10],
      ["BUILDING", "F", 20],
      ["AUTO", "O", 5],
    ],
    truncated: false,
  },
};
const none = () => undefined;

describe("the chart's settings", () => {
  it("offers every visual, with the chart's own marked", () => {
    const markup = renderToStaticMarkup(createElement(VisualGallery, { value: "donut", onPick: none }));
    expect(markup.match(/role="radio"/g)).toHaveLength(CHART_LOOKS.length);
    expect(markup).toContain('aria-checked="true" aria-label="Donut"');
  });

  it("draws the wells of a chart with a related column on x, in its short name", () => {
    const markup = renderToStaticMarkup(createElement(FieldWells, { widget: chart(), datasets, found, onChange: none }));
    for (const label of ["X axis", "Legend", "Values"]) expect(markup).toContain(`aria-label="${label}"`);
    expect(markup).toContain(">segment<");
    expect(markup).toContain(">Sum of total<");
    expect(markup).toContain(">Sum · orders.total<");
    expect(markup).toContain(">customer<");
    // nothing to choose from until a slot is clicked
    expect(markup).not.toContain("Change column");
  });

  it("has no x or legend well on a card, and no legend well on a pie", () => {
    const card = renderToStaticMarkup(createElement(FieldWells, { widget: chart({ spec: { kind: "counter", x: "", y: [], agg: "sum" } }), datasets, found, onChange: none }));
    expect(card).not.toContain('aria-label="X axis"');
    const pie = renderToStaticMarkup(createElement(FieldWells, { widget: chart({ spec: { kind: "pie", x: "status", y: [], agg: "sum" } }), datasets, found, onChange: none }));
    expect(pie).toContain('aria-label="X axis"');
    expect(pie).not.toContain('aria-label="Legend"');
  });

  it("offers a color per series it draws", () => {
    const markup = renderToStaticMarkup(createElement(ChartStyleSettings, { widget: chart(), data, onChange: none }));
    expect(markup).toContain('aria-label="Color of O"');
    expect(markup).toContain('aria-label="Color of F"');
    expect(markup).toContain("Palette");
    expect(markup).toContain("Color of each series");
    expect(markup).toContain("Gridlines");
  });

  it("has no legend setting for one series, whose color says what it is of", () => {
    const one: WidgetData = { kind: "chart", columns: [], data: { columns: ["status", "n"], rows: [["O", 1]], truncated: false } };
    const markup = renderToStaticMarkup(createElement(ChartStyleSettings, { widget: chart({ spec: { kind: "bar", x: "status", y: [], agg: "sum" } }), data: one, onChange: none }));
    expect(markup).toContain("Color of each series");
    // the only color: its choices show right there, not behind a box
    expect(markup).toContain('aria-label="Pick any color"');
    expect(markup).toContain('aria-label="#ffffff"');
    expect(markup).not.toContain("Legend");
  });

  it("colors by what the look draws", () => {
    expect(colorItems(chart({ spec: { kind: "pie", x: "customer.segment", y: [], agg: "sum" }, style: { look: "donut" } }), { ...data, data: { columns: ["customer.segment", "Sum of total"], rows: [["AUTO", 1], ["BUILDING", 2]], truncated: false } })).toEqual(["AUTO", "BUILDING"]);
    expect(colorItems(chart({ style: { look: "waterfall" } }), data)).toEqual(["Increase", "Decrease", "Total"]);
    expect(colorItems(chart({ spec: { kind: "counter", x: "", y: [], agg: "sum" } }), undefined)).toEqual(["Sum of total"]);
    expect(colorItems(chart(), undefined)).toEqual([]);
  });

  it("draws the panel of a chart, and of a table with a related column", () => {
    const load = () => Promise.resolve([]);
    const of = (widget: ChartWidget | TableWidget) => renderToStaticMarkup(createElement(WidgetPanel, { widget, data: undefined, datasets, found, load, onChange: none, onClose: none }));
    expect(of(chart())).toContain('aria-label="Visual"');
    expect(of(chart({ spec: { kind: "scatter", x: "total", y: ["total"], agg: "none" } }))).toContain('aria-label="Visual"');
    expect(of({ id: "t", kind: "table", dataset: "orders", columns: ["status", "customer.segment"] })).toContain("customer.segment");
  });
});

describe("the Data tab's measures", () => {
  const span = { from: 0, to: 0, line: 1, col: 1 };
  const measure = (name: string, dataset: string) => ({ name, datasets: [dataset], atoms: [], expr: [], span });
  const state = { source: "", setSource: () => Promise.resolve(), model: { relationships: [], calendars: [], params: [], measures: [measure("revenue", "orders"), measure("people", "customer"), measure("lost", "gone")] } };
  const formula = { target: { mode: "edit", name: "people", select: "end", key: 1 } as const, openNew: none, openEdit: none, select: none, close: none };
  const actions = { usedBy: () => [], add: () => Promise.resolve(), save: () => Promise.resolve(), remove: () => Promise.resolve() };

  it("groups them by dataset, with a search and the one being edited marked", () => {
    const markup = renderToStaticMarkup(createElement(ModelContext.Provider, { value: state }, createElement(MeasureList, { datasets, widgets: [], formula, actions })));
    expect(markup).toContain('aria-label="Search measures"');
    expect(markup.indexOf(">orders<")).toBeLessThan(markup.indexOf(">revenue<"));
    expect(markup.indexOf(">customer<")).toBeLessThan(markup.indexOf(">people<"));
    expect(markup).toContain(">lost<");
    expect(markup.match(/class="[^"]*Mui-selected/g)).toHaveLength(1);
  });
});

describe("what the canvas draws", () => {
  it("draws a matrix: a row per x, a column per series", () => {
    const markup = renderToStaticMarkup(createElement(MatrixView, { widget: chart({ style: { look: "matrix", format: { style: "number", decimals: 0 } } }), data: data as Extract<WidgetData, { kind: "chart" }> }));
    expect(markup).toContain(">segment<");
    expect(markup).toContain(">BUILDING<");
    expect(markup).toContain(">O<");
    expect(markup).toContain(">F<");
    expect(markup).toContain(">—<");
  });

  it("says what a chart still needs instead of drawing nothing", () => {
    const markup = renderToStaticMarkup(createElement(WidgetBody, { widget: chart({ values: undefined }), data: undefined, loading: false }));
    expect(markup).toContain("Add a value from the Fields pane");
  });

  it("heads a related column of a table by its own name", () => {
    const widget: TableWidget = { id: "t", kind: "table", dataset: "orders" };
    const shown: WidgetData = { kind: "table", columns: [{ name: "customer.segment", type: "string" }], rows: [["AUTO"]], total: 1 };
    expect(renderToStaticMarkup(createElement(WidgetBody, { widget, data: shown, loading: false }))).toContain(">segment<");
  });
});

describe("the widget's file", () => {
  it("keeps everything the settings set", () => {
    const widget = chart({
      sort: "value_asc",
      top: 5,
      style: { look: "hbar_stacked", palette: "ocean", colors: { O: "#112233" }, legend: "right", gridlines: false, smooth: true, x_title: "Segmento", y_title: "R$", gauge_max: 10, labels: true },
    });
    expect(parseWidget("abcd1234", widgetJson(widget))).toEqual({ ...widget, id: "abcd1234" });
  });

  it.each([{ look: "radar" }, { palette: "rainbow" }, { legend: "center" }, { colors: { a: "red" } }, { gauge_max: 0 }, { smooth: "yes" }, { x_title: 3 }])("refuses the style %j", (style) => {
    expect(() => parseWidget("abcd1234", JSON.stringify({ ...chart({ id: undefined as never }), style }))).toThrow();
  });
});
