import { describe, expect, it } from "vitest";

import type { NumberFormat } from "@/lib/dashboards/types";
import { parse } from "@/lib/model/parse";

import { measureText, removeMeasure, renameInSource, replaceMeasure, withFormat } from "./modelEdits";

const SRC = [
  "from iara.model import sum, measure",
  "",
  "# the money",
  'revenue = measure(sum(orders.total), format="currency", label="Revenue")  # gross',
  "orders_n = count_rows(orders)",
  "",
].join("\n");

const percent1: NumberFormat = { style: "percent", decimals: 1 };
const usd: NumberFormat = { style: "currency", currency: "USD", decimals: 0, compact: true };

describe("measureText", () => {
  it("returns the text of the statement that defines the name", () => {
    expect(measureText(SRC, "revenue")).toBe('revenue = measure(sum(orders.total), format="currency", label="Revenue")');
    expect(measureText(SRC, "orders_n")).toBe("orders_n = count_rows(orders)");
  });

  it("returns a multi-line statement inside parentheses whole", () => {
    const src = 'm = measure(\n    sum(orders.total),\n    format="percent",  # share\n)\nn = 1\n';
    expect(measureText(src, "m")).toBe('m = measure(\n    sum(orders.total),\n    format="percent",  # share\n)');
  });

  it("returns a measure with errors that still parses", () => {
    expect(measureText("m = sum(orders.nope)\n", "m")).toBe("m = sum(orders.nope)");
  });

  it("returns a line that did not parse, through its end", () => {
    expect(measureText("m = sum(orders.total) extra words  # note\nn = 1\n", "m")).toBe("m = sum(orders.total) extra words  # note");
  });

  it("returns null for a name with no definition, even when it is used", () => {
    expect(measureText(SRC, "nope")).toBeNull();
    expect(measureText("b = a * 2\n", "a")).toBeNull();
  });

  it("takes the first definition, as the checker does", () => {
    expect(measureText("a = 1\na = 2\n", "a")).toBe("a = 1");
  });
});

describe("replaceMeasure", () => {
  it("replaces the statement and keeps the rest of the file, comments included", () => {
    expect(replaceMeasure(SRC, "revenue", "revenue = sum(orders.total)")).toBe(
      ["from iara.model import sum, measure", "", "# the money", "revenue = sum(orders.total)  # gross", "orders_n = count_rows(orders)", ""].join("\n"),
    );
  });

  it("replaces a multi-line statement inside parentheses", () => {
    expect(replaceMeasure("m = sum(\n  orders.a,\n)\nn = 1\n", "m", "m = 2")).toBe("m = 2\nn = 1\n");
  });

  it("replaces a line that did not parse, whole", () => {
    expect(replaceMeasure("m = sum(orders.a) junk  # old\nn = 1\n", "m", "m = sum(orders.b)")).toBe("m = sum(orders.b)\nn = 1\n");
  });

  it("throws when there is no such measure", () => {
    expect(() => replaceMeasure(SRC, "nope", "x = 1")).toThrow(/nope/);
  });
});

describe("removeMeasure", () => {
  it("removes the statement and its line break", () => {
    expect(removeMeasure(SRC, "orders_n")).toBe(["from iara.model import sum, measure", "", "# the money", 'revenue = measure(sum(orders.total), format="currency", label="Revenue")  # gross', ""].join("\n"));
  });

  it("removes the trailing comment on the statement's line with it", () => {
    expect(removeMeasure(SRC, "revenue")).toBe(["from iara.model import sum, measure", "", "# the money", "orders_n = count_rows(orders)", ""].join("\n"));
  });

  it("removes a multi-line statement inside parentheses", () => {
    expect(removeMeasure("a = 1\nm = sum(\n  orders.a,\n)\nb = 2", "m")).toBe("a = 1\nb = 2");
  });

  it("removes the last line when it has no line break", () => {
    expect(removeMeasure("a = 1\nm = 2", "m")).toBe("a = 1\n");
  });

  it("throws when there is no such measure", () => {
    expect(() => removeMeasure(SRC, "nope")).toThrow(/nope/);
  });
});

describe("renameInSource", () => {
  it("renames the assignment target and the bare names used in expressions", () => {
    expect(renameInSource("revenue = sum(orders.total)\ndouble = revenue * 2\n", "revenue", "sales")).toBe("sales = sum(orders.total)\ndouble = sales * 2\n");
  });

  it("does not touch orders.revenue when renaming revenue", () => {
    expect(renameInSource("revenue = sum(orders.revenue)\nx = revenue\n", "revenue", "sales")).toBe("sales = sum(orders.revenue)\nx = sales\n");
  });

  it("does not touch names inside strings or comments", () => {
    const src = 'revenue = measure(sum(orders.total), label="revenue")  # revenue here\n';
    expect(renameInSource(src, "revenue", "sales")).toBe('sales = measure(sum(orders.total), label="revenue")  # revenue here\n');
  });

  it("keeps keyword argument names, which are not bare names", () => {
    expect(renameInSource('label = 1\nm = measure(sum(orders.a), label="x")\nn = label\n', "label", "title")).toBe('title = 1\nm = measure(sum(orders.a), label="x")\nn = title\n');
  });

  it("renames inside a multi-line statement and a line that did not parse", () => {
    expect(renameInSource("revenue = sum(\n  orders.a,\n)\nm = revenue / 2 +\n", "revenue", "sales")).toBe("sales = sum(\n  orders.a,\n)\nm = sales / 2 +\n");
  });

  it("renames a name in parentheses in its own place", () => {
    expect(renameInSource("m = (revenue) * 2\n", "revenue", "sales")).toBe("m = (sales) * 2\n");
  });

  it("does not rename a called function, nor a name in an import", () => {
    expect(renameInSource("m = revenue(orders.a)\n", "revenue", "sales")).toBe("m = revenue(orders.a)\n");
    expect(renameInSource("from iara.model import sum\n", "iara", "x")).toBe("from iara.model import sum\n");
  });

  it("returns the source unchanged when the name is not used", () => {
    expect(renameInSource(SRC, "nope", "x")).toBe(SRC);
  });
});

describe("withFormat", () => {
  it("wraps a plain value in measure() with the format", () => {
    expect(withFormat("revenue = sum(orders.total)", percent1)).toBe('revenue = measure(sum(orders.total), format="percent", decimals=1)');
  });

  it("wraps a parenthesized value whole and keeps the comment after it", () => {
    expect(withFormat("revenue = (sum(orders.a) - sum(orders.b))  # net", percent1)).toBe(
      'revenue = measure((sum(orders.a) - sum(orders.b)), format="percent", decimals=1)  # net',
    );
  });

  it("writes the keywords in order: format, decimals, currency, compact; currency only with its style", () => {
    expect(withFormat("revenue = sum(orders.total)", usd)).toBe('revenue = measure(sum(orders.total), format="currency", decimals=0, currency="USD", compact=True)');
    expect(withFormat("m = sum(orders.a)", { style: "percent", currency: "USD" })).toBe('m = measure(sum(orders.a), format="percent")');
  });

  it("rewrites the format of a measure and keeps its expression and label", () => {
    expect(withFormat('revenue = measure(sum(orders.total), format="currency", label="Revenue")', percent1)).toBe(
      'revenue = measure(sum(orders.total), format="percent", decimals=1, label="Revenue")',
    );
  });

  it("removes the format keywords of a measure and keeps its label", () => {
    expect(withFormat('revenue = measure(sum(orders.total), format="currency", label="Revenue")', null)).toBe('revenue = measure(sum(orders.total), label="Revenue")');
  });

  it("unwraps a measure left with only its expression", () => {
    expect(withFormat('revenue = measure(sum(orders.total), format="currency")', null)).toBe("revenue = sum(orders.total)");
    expect(withFormat("m = measure(expr=sum(orders.a), format=\"currency\")", null)).toBe("m = sum(orders.a)");
  });

  it("leaves a plain value alone when no format is asked", () => {
    expect(withFormat("revenue = sum(orders.total)", null)).toBe("revenue = sum(orders.total)");
  });

  it("adds a format to a measure that has none, after its arguments", () => {
    expect(withFormat('revenue = measure(sum(orders.total), label="Revenue")', percent1)).toBe(
      'revenue = measure(sum(orders.total), label="Revenue", format="percent", decimals=1)',
    );
  });

  it("keeps the layout of a multi-line measure and its comments", () => {
    const line = 'revenue = measure(\n    sum(orders.total),  # gross\n    format="currency",\n    label="Revenue",\n)';
    expect(withFormat(line, percent1)).toBe('revenue = measure(\n    sum(orders.total),  # gross\n    format="percent", decimals=1,\n    label="Revenue",\n)');
    expect(withFormat(line, null)).toBe('revenue = measure(\n    sum(orders.total),  # gross\n    label="Revenue",\n)');
  });

  it("gives a measure that has errors but parses the new format", () => {
    expect(withFormat("m = sum(orders.nope)", percent1)).toBe('m = measure(sum(orders.nope), format="percent", decimals=1)');
  });

  it("returns a line that still parses", () => {
    expect(parse(withFormat("revenue = sum(orders.total)", usd)).diagnostics).toEqual([]);
  });

  it("throws unless the line is one name = expression statement", () => {
    expect(() => withFormat("", percent1)).toThrow();
    expect(() => withFormat("a = 1\nb = 2", percent1)).toThrow();
    expect(() => withFormat("sum(orders.a)", percent1)).toThrow();
    expect(() => withFormat("a = sum(orders.a", percent1)).toThrow();
  });
});
