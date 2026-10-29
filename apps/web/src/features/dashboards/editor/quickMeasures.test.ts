import { describe, expect, it } from "vitest";

import { checkAdded } from "./measureLine";
import { freeName, QUICK_TEMPLATES, quickMeasure, suggestName, type QuickFields, type QuickKind } from "./quickMeasures";

const none = { dataset: "", column: "" };
const fields = (f: Partial<QuickFields>): QuickFields => ({ dataset: "", column: "", measure: "", n: 3, date: none, ...f });
const span = { from: 0, to: 0, line: 1, col: 1 };
const calendar = { name: "dates", columns: [{ dataset: "orders", column: "placed" }], span };

const text = (kind: QuickKind, f: Partial<QuickFields>, calendars = [calendar]) => quickMeasure(kind, fields(f), "m", calendars, [])?.text;

describe("quickMeasure", () => {
  it("aggregates a column or counts a dataset's rows", () => {
    const f = { dataset: "orders", column: "total" };
    expect(text("sum", f)).toBe("m = sum(orders.total)");
    expect(text("avg", f)).toBe("m = avg(orders.total)");
    expect(text("min", f)).toBe("m = min(orders.total)");
    expect(text("max", f)).toBe("m = max(orders.total)");
    expect(text("count", f)).toBe("m = count(orders.total)");
    expect(text("distinct", f)).toBe("m = count_distinct(orders.total)");
    expect(text("rows", { dataset: "orders" })).toBe("m = count_rows(orders)");
  });

  it("totals over a dataset or one of its columns", () => {
    expect(text("percent", { measure: "revenue", dataset: "orders" })).toBe("m = divide(revenue, calculate(revenue, all_(orders)))");
    expect(text("percent", { measure: "revenue", dataset: "orders", column: "region" })).toBe("m = divide(revenue, calculate(revenue, all_(orders.region)))");
  });

  it("wraps a measure in time, running, rank and rolling functions", () => {
    const f = { measure: "revenue" };
    expect(text("ytd", f)).toBe("m = ytd(revenue)");
    expect(text("qtd", f)).toBe("m = qtd(revenue)");
    expect(text("mtd", f)).toBe("m = mtd(revenue)");
    expect(text("yoy", f)).toBe("m = divide(revenue - previous_year(revenue), previous_year(revenue))");
    expect(text("running", f)).toBe("m = running_total(revenue)");
    expect(text("rank", f)).toBe("m = rank(revenue)");
    expect(text("rolling", { ...f, n: 7 })).toBe("m = rolling(revenue, 7)");
  });

  it("gives nothing while a field or the name is missing", () => {
    expect(text("sum", { dataset: "orders" })).toBeUndefined();
    expect(text("ytd", {})).toBeUndefined();
    expect(text("percent", { measure: "revenue" })).toBeUndefined();
    expect(text("rolling", { measure: "revenue", n: 0 })).toBeUndefined();
    expect(text("rolling", { measure: "revenue", n: 1.5 })).toBeUndefined();
    expect(quickMeasure("rows", fields({ dataset: "orders" }), "  ", [], [])).toBeNull();
  });

  it("adds a calendar first when a time template finds the model without one", () => {
    const f = fields({ measure: "revenue", date: { dataset: "orders", column: "placed" } });
    expect(quickMeasure("ytd", f, "revenue_ytd", [], [])).toEqual({
      text: "revenue_ytd = ytd(revenue)",
      lines: ["dates = calendar(orders.placed)", "revenue_ytd = ytd(revenue)"],
    });
    // the name is not one of a dataset, a measure, a param… or the measure being added
    expect(quickMeasure("ytd", f, "x", [], ["dates"])?.lines[0]).toBe("dates_2 = calendar(orders.placed)");
    expect(quickMeasure("ytd", f, "dates", [], [])?.lines[0]).toBe("dates_2 = calendar(orders.placed)");
    // it needs the date column to build one
    expect(quickMeasure("ytd", fields({ measure: "revenue" }), "x", [], [])).toBeNull();
    // the others (and a model that has a calendar) add the line alone
    expect(quickMeasure("ytd", f, "x", [calendar], [])?.lines).toEqual(["x = ytd(revenue)"]);
    expect(quickMeasure("rank", f, "x", [], [])?.lines).toEqual(["x = rank(revenue)"]);
  });
});

describe("suggestName", () => {
  it("names the measure after what it reads, free among the taken", () => {
    expect(suggestName("sum", fields({ dataset: "orders", column: "total" }), [])).toBe("sum_total");
    expect(suggestName("sum", fields({ dataset: "orders", column: "total" }), ["sum_total"])).toBe("sum_total_2");
    expect(suggestName("rows", fields({ dataset: "orders" }), [])).toBe("orders_rows");
    expect(suggestName("percent", fields({ measure: "revenue" }), [])).toBe("revenue_pct_of_total");
    expect(suggestName("yoy", fields({ measure: "revenue" }), [])).toBe("revenue_yoy");
    expect(suggestName("rolling", fields({ measure: "revenue", n: 7 }), [])).toBe("revenue_rolling_7");
  });

  it("is a valid name for any column", () => {
    expect(suggestName("sum", fields({ column: "unit price (€)" }), [])).toMatch(/^[A-Za-z_]\w*$/);
    expect(suggestName("rows", fields({ dataset: "2024_sales" }), [])).toMatch(/^[A-Za-z_]\w*$/);
  });
});

describe("freeName", () => {
  it("counts up from 2", () => {
    expect(freeName("a", [])).toBe("a");
    expect(freeName("a", ["a", "a_2"])).toBe("a_3");
  });
});

describe("the templates check", () => {
  const schema = { orders: ["total", "region", "placed"] };
  const source = "revenue = sum(orders.total)\n";
  const f = fields({ dataset: "orders", column: "total", measure: "revenue", n: 3, date: { dataset: "orders", column: "placed" } });

  // each template's line goes through the model's checker, the calendar's too
  it.each(QUICK_TEMPLATES.map((t) => t.kind))("%s", (kind) => {
    const built = quickMeasure(kind, kind === "percent" ? { ...f, column: "region" } : f, "result", [], ["orders", "revenue"]);
    expect(built).not.toBeNull();
    const checked = checkAdded(source, built!.lines.join("\n"), schema);
    expect(checked.diagnostics).toEqual([]);
    expect(checked.measure).toBe("result");
  });
});
