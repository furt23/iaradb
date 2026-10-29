import { describe, expect, it } from "vitest";

import { checkModel } from "./check";
import { ALLOWED } from "./parse";
import { render } from "./parts";
import type { Checked, Measure, Schema } from "./types";

const SCHEMA: Schema = {
  orders: ["a", "b", "status", "day"],
  customers: ["id", "name"],
  items: ["order_id", "qty"],
  loose: null,
};

const check = (source: string, schema: Schema = SCHEMA): Checked => checkModel(source, schema);
const messages = (source: string, schema?: Schema) => check(source, schema).diagnostics.map((d) => d.message);
const measureOf = (source: string, name = "m"): Measure | undefined => check(source).model.measures.find((m) => m.name === name);
/** the SQL of a measure with its atoms written in place of the holes */
const sqlOf = (source: string, name = "m") => {
  const m = measureOf(source, name);
  return m && render(m.expr, (i) => m.atoms[i].sql);
};

describe("imports", () => {
  it("are optional, and every function and dataset works without them", () => {
    expect(messages("m = sum(orders.a)")).toEqual([]);
  });

  it("accept model functions, one or many, in parentheses too", () => {
    expect(messages("from iara.model import sum, measure, relate, if_")).toEqual([]);
    expect(messages("from iara.model import (\n  sum,\n  count_rows,\n)\nm = sum(orders.a)")).toEqual([]);
  });

  it("refuse a name iara.model does not have", () => {
    const d = check("from iara.model import sum, nope").diagnostics;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ message: "iara.model has no nope", severity: "error", line: 1, col: 29 });
  });

  it("accept every function of the language", () => {
    expect(messages("from iara.model import calendar, ytd, calculate, all_, switch, param, rank, rolling, running_total")).toEqual([]);
  });

  it("refuse other modules", () => {
    expect(messages("from math import pi")).toEqual(["only `iara.model` can be imported, not `math`"]);
    expect(messages("import os")[0]).toContain("`import x` is not allowed");
  });
});

describe("names", () => {
  it("rejects unknown names and unknown functions", () => {
    expect(messages("m = sum(nope.a)")).toEqual(["unknown name nope"]);
    expect(messages("m = nope(1)")).toEqual(["unknown function nope"]);
    expect(messages("m = orders(1)")).toEqual(["unknown function orders"]);
    expect(messages("m = rank")).toEqual(["`rank` is a function: call it, e.g. rank(...)"]);
  });

  it("points the unknown-function error at the function name", () => {
    expect(check("m = sum(orders.a) + nope(2)").diagnostics[0]).toMatchObject({ from: 20, to: 24, col: 21 });
  });

  it("does not take a bare dataset or a function name as a value", () => {
    expect(messages("m = orders")[0]).toBe("`orders` is a dataset, not a value: use orders.column or count_rows(orders)");
    expect(messages("m = sum(orders)")[0]).toContain("`orders` is a dataset, not a value");
    expect(messages("m = sum")[0]).toBe("`sum` is a function: call it, e.g. sum(...)");
  });

  it("does not let a dataset, a function or an earlier name be assigned again", () => {
    expect(messages("orders = 1")).toEqual(["`orders` is a dataset name: pick another name"]);
    expect(messages("sum = 1")).toEqual(["`sum` is a function name: pick another name"]);
    expect(messages("calendar = 1")).toEqual(["`calendar` is a function name: pick another name"]);
    const d = check("m = sum(orders.a)\nm = sum(orders.b)").diagnostics;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ message: "`m` is already defined", line: 2, col: 1, from: 18, to: 19 });
  });

  it("keeps the first definition when the second is refused", () => {
    expect(sqlOf("m = sum(orders.a)\nm = sum(orders.b)")).toBe('SUM("a")');
  });

  it("needs an earlier line: a name is not known before it is defined", () => {
    expect(messages("m = n + 1\nn = 2")).toEqual(["unknown name n"]);
  });
});

describe("levels", () => {
  it("makes a measure of an aggregate", () => {
    const { model, diagnostics } = check("revenue = sum(orders.a)");
    expect(diagnostics).toEqual([]);
    expect(model.measures).toEqual([
      {
        name: "revenue",
        datasets: ["orders"],
        atoms: [{ dataset: "orders", sql: 'SUM("a")', agg: "sum" }],
        expr: [{ atom: 0 }],
        span: { from: 0, to: 23, line: 1, col: 1 },
      },
    ]);
  });

  it("keeps the measures in file order", () => {
    expect(check("b = sum(orders.a)\na = avg(orders.a)").model.measures.map((m) => m.name)).toEqual(["b", "a"]);
  });

  it("refuses a value per row, naming the line", () => {
    expect(messages("x = orders.a")).toEqual(["`x` is a value per row: wrap it in an aggregation, e.g. sum(...)"]);
    expect(messages("x = orders.a * 2 + orders.b")[0]).toContain("`x` is a value per row");
    expect(messages("x = if_(orders.a > 1, 1, 0)")[0]).toContain("is a value per row");
    expect(check("x = orders.a").model.measures).toEqual([]);
  });

  it("makes a constant of a scalar, written out where it is used", () => {
    const source = "rate = 0.1\nk = 2 * 3\nm = sum(orders.a) * rate + k\nn = sum(orders.a * rate)";
    expect(check(source).diagnostics).toEqual([]);
    expect(check(source).model.measures.map((m) => m.name)).toEqual(["m", "n"]);
    expect(sqlOf(source, "m")).toBe('((SUM("a") * 0.1) + (2 * 3))');
    expect(sqlOf(source, "n")).toBe('SUM(("a" * 0.1))');
  });

  it("refuses an aggregation inside another, also through a measure", () => {
    expect(messages("m = sum(sum(orders.a))")[0]).toContain("an aggregation inside another is not allowed");
    expect(messages("r = sum(orders.a)\nm = avg(r)")[0]).toContain("an aggregation inside another is not allowed");
    expect(messages("m = sum(count_rows(orders))")[0]).toContain("an aggregation inside another");
  });

  it("refuses a bare column next to an aggregation, naming the first one", () => {
    const d = check("m = sum(orders.a) / orders.b").diagnostics;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ message: "`orders.b` must be inside an aggregation, e.g. sum(orders.b)", from: 20, to: 28, col: 21 });
    expect(messages("m = sum(orders.a) + orders.b * orders.a")[0]).toContain("`orders.b` must be inside");
    expect(messages("m = orders.a - sum(orders.b)")[0]).toContain("`orders.a` must be inside");
    expect(messages("m = if_(sum(orders.a) > 0, orders.b, 0)")[0]).toContain("`orders.b` must be inside");
    expect(messages("m = divide(sum(orders.a), orders.b)")[0]).toContain("`orders.b` must be inside");
    expect(messages("m = -(sum(orders.a) + orders.b)")[0]).toContain("`orders.b` must be inside");
  });

  it("lets row values meet inside an aggregation", () => {
    expect(sqlOf("m = sum(orders.a * orders.b - 1)")).toBe('SUM((("a" * "b") - 1))');
  });

  it("refuses arithmetic on text, also through a constant", () => {
    expect(messages('m = sum(orders.a) + "x"')[0]).toContain("arithmetic needs numbers");
    expect(messages('m = -"x"')[0]).toContain("arithmetic needs numbers");
    expect(messages('t = "x"\nm = sum(orders.a) * t')[0]).toContain("arithmetic needs numbers");
    expect(messages('m = divide("x", sum(orders.a))')[0]).toContain("arithmetic needs numbers");
    expect(messages('m = sum(if_(orders.status == "x", 1, 0))')).toEqual([]);
  });

  it("has count_rows(dataset) as an aggregate, and nothing else takes a dataset", () => {
    expect(sqlOf("m = count_rows(orders)")).toBe("COUNT(*)");
    expect(measureOf("m = count_rows(orders)")).toMatchObject({ datasets: ["orders"], atoms: [{ dataset: "orders", sql: "COUNT(*)", agg: "count" }] });
    expect(messages("m = count_rows(orders.a)")[0]).toContain("expected a dataset name");
    expect(messages("m = count_rows(1)")[0]).toContain("expected a dataset name");
    expect(messages("m = count_rows(nope)")).toEqual(["unknown name nope"]);
    expect(messages("r = sum(orders.a)\nm = count_rows(r)")[0]).toContain("expected a dataset name");
  });

  it("checks the number of arguments and their names", () => {
    expect(messages("m = sum()")).toEqual(["sum() is missing `expr`"]);
    expect(messages("m = sum(orders.a, 2)")).toEqual(["sum() takes 1 argument, got 2"]);
    expect(messages("m = sum(foo=1)")).toEqual(["sum() has no argument named foo"]);
    expect(messages("m = sum(orders.a, expr=1)")).toEqual(["sum() got expr twice"]);
    expect(messages("m = sum(orders.a)\nn = sum(expr=orders.a, expr=1)")[0]).toContain("is given twice");
    expect(sqlOf("m = sum(expr=orders.a)")).toBe('SUM("a")');
    expect(messages("m = if_(1, 2)")).toEqual(["if_() is missing `else`"]);
    expect(messages("m = divide(1)")).toEqual(["divide() is missing `b`"]);
    expect(messages("m = divide(1, 2, 3, 4)")[0]).toBe("divide() takes 3 arguments, got 4");
    expect(messages("m = divide(1, 2, 3, alternate=4)")[0]).toBe("divide() got alternate twice");
  });
});

describe("SQL", () => {
  it("renders the aggregations", () => {
    expect(sqlOf("m = sum(orders.a)")).toBe('SUM("a")');
    expect(sqlOf("m = avg(orders.a)")).toBe('(CAST(SUM("a") AS DOUBLE) / NULLIF(COUNT("a"), 0))');
    expect(sqlOf("m = min(orders.a)")).toBe('MIN("a")');
    expect(sqlOf("m = max(orders.a)")).toBe('MAX("a")');
    expect(sqlOf("m = count(orders.a)")).toBe('COUNT("a")');
    expect(sqlOf("m = count_distinct(orders.b)")).toBe('COUNT(DISTINCT "b")');
  });

  it("renders literals", () => {
    expect(sqlOf("m = sum(orders.a * 1_000.5)")).toBe('SUM(("a" * 1000.5))');
    expect(sqlOf("m = max(if_(orders.a > 1, True, None))")).toBe('MAX(CASE WHEN ("a" > 1) THEN TRUE ELSE NULL END)');
    expect(sqlOf("m = max(if_(orders.a > 1, False, 'it\\'s'))")).toBe("MAX(CASE WHEN (\"a\" > 1) THEN FALSE ELSE 'it''s' END)");
    expect(sqlOf('m = count(if_(orders.status == "paid", 1, None))')).toBe('COUNT(CASE WHEN ("status" = \'paid\') THEN 1 ELSE NULL END)');
  });

  it("renders the operators", () => {
    expect(sqlOf("m = sum(orders.a + orders.b)")).toBe('SUM(("a" + "b"))');
    expect(sqlOf("m = sum(orders.a - orders.b)")).toBe('SUM(("a" - "b"))');
    expect(sqlOf("m = sum(orders.a * orders.b)")).toBe('SUM(("a" * "b"))');
    expect(sqlOf("m = sum(orders.a % 2)")).toBe('SUM(("a" % 2))');
    expect(sqlOf("m = sum(-orders.a)")).toBe('SUM((-"a"))');
    expect(sqlOf("m = sum(+orders.a)")).toBe('SUM("a")');
    expect(sqlOf("m = sum(orders.a / 2)")).toBe('SUM((CAST(("a") AS DOUBLE) / (2)))');
  });

  it("renders comparisons and logic", () => {
    expect(sqlOf('m = count(if_(orders.a == 1, 1, None))')).toContain('("a" = 1)');
    expect(sqlOf('m = count(if_(orders.a != 1, 1, None))')).toContain('("a" <> 1)');
    for (const op of ["<", "<=", ">", ">="]) expect(sqlOf(`m = count(if_(orders.a ${op} 1, 1, None))`)).toContain(`("a" ${op} 1)`);
    expect(sqlOf("m = sum(if_(orders.a > 1 and orders.b < 2 or not orders.a == 0, 1, 0))")).toBe(
      'SUM(CASE WHEN ((("a" > 1) AND ("b" < 2)) OR (NOT ("a" = 0))) THEN 1 ELSE 0 END)',
    );
  });

  it("renders / as a true division between aggregates", () => {
    expect(sqlOf("m = sum(orders.a) / sum(orders.b)")).toBe('(CAST((SUM("a")) AS DOUBLE) / (SUM("b")))');
    expect(sqlOf("m = (sum(orders.a) - sum(orders.b)) / sum(orders.a)")).toBe(
      '(CAST(((SUM("a") - SUM("b"))) AS DOUBLE) / (SUM("a")))',
    );
  });

  it("renders divide with a NULL or given alternate", () => {
    const body = 'CASE WHEN (SUM("b")) = 0 OR (SUM("b")) IS NULL THEN';
    expect(sqlOf("m = divide(sum(orders.a), sum(orders.b))")).toBe(`${body} NULL ELSE CAST((SUM("a")) AS DOUBLE) / (SUM("b")) END`);
    expect(sqlOf("m = divide(sum(orders.a), sum(orders.b), alternate=0)")).toBe(`${body} 0 ELSE CAST((SUM("a")) AS DOUBLE) / (SUM("b")) END`);
    expect(sqlOf("m = divide(sum(orders.a), sum(orders.b), 0)")).toBe(`${body} 0 ELSE CAST((SUM("a")) AS DOUBLE) / (SUM("b")) END`);
    expect(sqlOf("m = divide(sum(orders.a), sum(orders.b), None)")).toContain("THEN NULL ELSE");
  });

  it("renders a referenced measure in parentheses and chains through measures", () => {
    expect(sqlOf("r = sum(orders.a)\nm = r * 2", "m")).toBe('((SUM("a")) * 2)');
    expect(sqlOf("r = sum(orders.a)\nc = sum(orders.b)\nm = r / c", "m")).toBe('(CAST(((SUM("a"))) AS DOUBLE) / ((SUM("b"))))');
    expect(sqlOf("r = sum(orders.a)\ns = r + 1\nm = s + 1", "m")).toBe('((((SUM("a")) + 1)) + 1)');
  });

  it("renders if_ inside an aggregation", () => {
    expect(sqlOf('m = sum(if_(orders.status == "paid", orders.a, 0))')).toBe('SUM(CASE WHEN ("status" = \'paid\') THEN "a" ELSE 0 END)');
  });
});

describe("the schema", () => {
  it("accepts the columns it lists and refuses the others", () => {
    expect(messages("m = sum(orders.a)")).toEqual([]);
    expect(messages("m = sum(orders.nope)")).toEqual(["orders has no column nope"]);
    expect(check("m = sum(orders.nope)").diagnostics[0]).toMatchObject({ from: 8, to: 19, col: 9 });
  });

  it("accepts any column of a dataset whose columns are not known", () => {
    expect(messages("m = sum(loose.anything * loose.else_)")).toEqual([]);
    expect(sqlOf("m = sum(loose.anything)")).toBe('SUM("anything")');
  });

  it("refuses a dataset that is not in the schema, and anything but dataset.column", () => {
    expect(messages("m = sum(nope.a)")).toEqual(["unknown name nope"]);
    expect(messages("m = sum(orders.a.b)")[0]).toContain("expected a column written dataset.column");
    expect(messages("r = sum(orders.a)\nm = sum(r.a)")[0]).toBe("`r` is not a dataset (datasets: orders, customers, items, loose)");
    expect(messages("m = sum(orders.a)", {})).toEqual(["unknown name orders"]);
  });

  it("uses the datasets of the schema as names without importing them", () => {
    expect(messages("m = count_rows(customers)")).toEqual([]);
  });
});

describe("atoms and templates", () => {
  it("makes an atom of each aggregation and leaves the text around it in the template", () => {
    const m = measureOf("m = (sum(orders.a) - sum(orders.b)) / sum(orders.a)")!;
    expect(m.atoms).toEqual([
      { dataset: "orders", sql: 'SUM("a")', agg: "sum" },
      { dataset: "orders", sql: 'SUM("b")', agg: "sum" },
    ]);
    expect(m.expr).toEqual(["(CAST(((", { atom: 0 }, " - ", { atom: 1 }, ")) AS DOUBLE) / (", { atom: 0 }, "))"]);
  });

  it("writes the same aggregation once, however often it is used", () => {
    const m = measureOf("m = sum(orders.a) + sum(orders.a) * 2 + max(orders.a)")!;
    expect(m.atoms.map((a) => a.sql)).toEqual(['SUM("a")', 'MAX("a")']);
    expect(m.expr.filter((p) => typeof p !== "string")).toEqual([{ atom: 0 }, { atom: 0 }, { atom: 1 }]);
    expect(measureOf("m = divide(sum(orders.a), sum(orders.b))")!.atoms).toHaveLength(2);
  });

  it("does not mix the same SQL over two datasets", () => {
    const m = measureOf("m = count_rows(orders) + count_rows(customers)")!;
    expect(m.atoms).toEqual([
      { dataset: "orders", sql: "COUNT(*)", agg: "count" },
      { dataset: "customers", sql: "COUNT(*)", agg: "count" },
    ]);
  });

  it("keeps constants and the operators in the template, not in the atoms", () => {
    expect(measureOf("m = sum(orders.a) * 2 + 1")).toMatchObject({ atoms: [{ sql: 'SUM("a")' }], expr: ["((", { atom: 0 }, " * 2) + 1)"] });
  });
});

describe("one dataset per aggregation", () => {
  it("refuses an aggregation that reads two datasets, naming them in order", () => {
    expect(messages("m = sum(orders.a * customers.id)")).toEqual(["an aggregation reads one dataset: sum(...) reads orders and customers"]);
    expect(messages("m = count_distinct(orders.a + customers.id)")).toEqual(["an aggregation reads one dataset: count_distinct(...) reads orders and customers"]);
    expect(messages("m = sum(orders.a + customers.id + items.qty)")).toEqual([
      "an aggregation reads one dataset: sum(...) reads orders, customers and items",
    ]);
  });

  it("points the error at the aggregation", () => {
    expect(check("m = 1 + sum(orders.a * customers.id)").diagnostics[0]).toMatchObject({ from: 8, to: 36, col: 9 });
  });

  it("needs a dataset: an aggregate of constants reads none", () => {
    expect(messages("m = sum(1)")).toEqual(["sum() does not read any dataset: aggregate a column, e.g. sum(orders.total)"]);
  });
});

describe("measures over several datasets", () => {
  it("lets a measure combine aggregations of different datasets", () => {
    const { model, diagnostics } = check("ratio = sum(orders.a) / sum(customers.id)");
    expect(diagnostics).toEqual([]);
    expect(model.measures[0]).toMatchObject({
      datasets: ["orders", "customers"],
      atoms: [
        { dataset: "orders", sql: 'SUM("a")', agg: "sum" },
        { dataset: "customers", sql: 'SUM("id")', agg: "sum" },
      ],
    });
  });

  it("lists the datasets in order of first use", () => {
    expect(measureOf("m = sum(customers.id) + sum(orders.a) + sum(customers.id) + sum(items.qty)")!.datasets).toEqual(["customers", "orders", "items"]);
    expect(measureOf("m = sum(orders.a) + sum(orders.b)")!.datasets).toEqual(["orders"]);
  });
});

describe("measures that use measures", () => {
  it("brings the atoms and the template of the measure used, in parentheses", () => {
    const m = measureOf("revenue = sum(orders.a)\norders_n = count_rows(orders)\nm = revenue / orders_n")!;
    expect(m.atoms).toEqual([
      { dataset: "orders", sql: 'SUM("a")', agg: "sum" },
      { dataset: "orders", sql: "COUNT(*)", agg: "count" },
    ]);
    expect(m.expr).toEqual(["(CAST(((", { atom: 0 }, ")) AS DOUBLE) / ((", { atom: 1 }, ")))"]);
  });

  it("numbers the atoms again in the new measure and does not repeat one already there", () => {
    const m = measureOf("a = sum(orders.a)\nb = sum(orders.b) + sum(orders.a)\nm = b - a")!;
    expect(m.atoms.map((x) => x.sql)).toEqual(['SUM("b")', 'SUM("a")']);
    expect(m.expr).toEqual(["(((", { atom: 0 }, " + ", { atom: 1 }, ")) - (", { atom: 1 }, "))"]);
  });

  it("combines measures of different datasets", () => {
    const m = measureOf("sales = sum(orders.a)\npeople = count_distinct(customers.id)\nm = sales / people")!;
    expect(m.datasets).toEqual(["orders", "customers"]);
  });

  it("does not change the measure it uses", () => {
    const { model } = check("a = sum(orders.a)\nm = a * 2");
    expect(model.measures[0]).toMatchObject({ atoms: [{ sql: 'SUM("a")', agg: "sum" }], expr: [{ atom: 0 }] });
  });
});

describe("measure()", () => {
  it("is a plain measure without options, with no format or label keys", () => {
    const [m] = check("m = measure(sum(orders.a))").model.measures;
    expect(m).toEqual({ name: "m", datasets: ["orders"], atoms: [{ dataset: "orders", sql: 'SUM("a")', agg: "sum" }], expr: [{ atom: 0 }], span: expect.anything() });
    expect("format" in m).toBe(false);
    expect("label" in m).toBe(false);
  });

  it("sets the format and the label", () => {
    const measures = (src: string) => check(src).model.measures[0];
    expect(measures('m = measure(sum(orders.a), format="currency")')).toMatchObject({ format: { style: "currency", currency: "BRL" } });
    expect(measures('m = measure(sum(orders.a), format="currency", currency="USD", decimals=0, compact=True, label="Revenue")')).toMatchObject({
      format: { style: "currency", currency: "USD", decimals: 0, compact: true },
      label: "Revenue",
    });
    expect(measures('m = measure(sum(orders.a), format="percent", decimals=1)').format).toEqual({ style: "percent", decimals: 1 });
    expect(measures('m = measure(sum(orders.a), format="number")').format).toEqual({ style: "number" });
    expect(measures("m = measure(sum(orders.a), decimals=2)").format).toEqual({ style: "number", decimals: 2 });
    expect(measures("m = measure(sum(orders.a), compact=False)").format).toEqual({ style: "number", compact: false });
    expect(measures('m = measure(sum(orders.a), label="Total")')).toMatchObject({ label: "Total" });
    expect(measures('m = measure(sum(orders.a), label="Total")').format).toBeUndefined();
    expect(measures('m = measure(sum(orders.a), format="currency", decimals=10)').format).toMatchObject({ decimals: 10 });
  });

  it("wraps a measure expression, and the result can be used by name", () => {
    expect(sqlOf('r = measure(sum(orders.a), format="currency")\nm = r * 2', "m")).toBe('((SUM("a")) * 2)');
    expect(sqlOf('m = measure(sum(orders.a) / sum(orders.b), format="percent")')).toBe('(CAST((SUM("a")) AS DOUBLE) / (SUM("b")))');
  });

  it("refuses bad options with a clear message", () => {
    expect(messages('m = measure(sum(orders.a), format="euro")')).toEqual(['format must be one of "number", "currency" or "percent", not "euro"']);
    expect(messages("m = measure(sum(orders.a), format=1)")).toEqual(["format must be a string in quotes"]);
    for (const d of ["11", "1.5", "-1", '"2"', "None"]) {
      expect(messages(`m = measure(sum(orders.a), decimals=${d})`)).toEqual(["decimals must be a whole number from 0 to 10"]);
    }
    expect(messages('m = measure(sum(orders.a), format="currency", currency="usd")')).toEqual(['currency must be 3 uppercase letters, e.g. "USD"']);
    expect(messages('m = measure(sum(orders.a), format="currency", currency="EURO")')[0]).toContain("3 uppercase letters");
    expect(messages('m = measure(sum(orders.a), format="percent", currency="USD")')).toEqual(['currency only applies to format="currency"']);
    expect(messages('m = measure(sum(orders.a), currency="USD")')).toEqual(['currency only applies to format="currency"']);
    expect(messages('m = measure(sum(orders.a), compact="yes")')).toEqual(["compact must be True or False"]);
    expect(messages("m = measure(sum(orders.a), label=5)")).toEqual(["label must be a string in quotes"]);
    expect(messages("m = measure(sum(orders.a), size=1)")).toEqual(["measure() has no argument named size"]);
    expect(messages('m = measure(sum(orders.a), "currency")')[0]).toContain("measure() takes 1 argument; pass format, decimals, currency, compact, label by name");
    expect(messages("m = measure()")).toEqual(["measure() is missing `expr`"]);
  });

  it("needs an aggregation", () => {
    expect(messages("m = measure(orders.a)")).toEqual(["`orders.a` must be inside an aggregation, e.g. sum(orders.a)"]);
    expect(messages("m = measure(5)")[0]).toContain("measure() needs an aggregation");
    expect(check("m = measure(5)").model.measures).toEqual([]);
  });

  it("is only the whole value of a line", () => {
    expect(messages("m = 1 + measure(sum(orders.a))")).toEqual(["measure(...) has to be the whole value of a line: name = measure(...)"]);
    expect(messages("m = sum(measure(sum(orders.a)))")[0]).toContain("has to be the whole value of a line");
    expect(messages("measure(sum(orders.a))")).toEqual([ALLOWED]);
  });
});

describe("broken lines", () => {
  it("leaves the broken measure out and keeps the rest", () => {
    const { model, diagnostics } = check("ok = sum(orders.a)\nbad = sum(orders.nope)\nalso_ok = avg(orders.b)");
    expect(model.measures.map((m) => m.name)).toEqual(["ok", "also_ok"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].line).toBe(2);
  });

  it("says `x` has an error for what uses a broken measure, and so on down the chain", () => {
    const d = check("a = orders.nope\nb = sum(a)\nc = a + 1\nd = c").diagnostics.map((x) => [x.line, x.message]);
    expect(d).toEqual([
      [1, "orders has no column nope"],
      [2, "`a` has an error"],
      [3, "`a` has an error"],
      [4, "`c` has an error"],
    ]);
  });

  it("keeps a broken name taken", () => {
    expect(messages("a = orders.nope\na = 5")).toEqual(["orders has no column nope", "`a` is already defined"]);
  });

  it("does the same for a line that does not parse", () => {
    const { model, diagnostics } = check("total = sum(\nx = total + 1\ny = sum(orders.a)");
    expect(model.measures).toEqual([]);
    expect(diagnostics).toHaveLength(1); // the open parenthesis swallows what follows
    const split = check("total = sum(orders.a) +\nx = total + 1\ny = sum(orders.a)");
    expect(split.model.measures.map((m) => m.name)).toEqual(["y"]);
    expect(split.diagnostics.map((d) => [d.line, d.message])).toEqual([
      [1, "expected an expression, found the end of the line"],
      [2, "`total` has an error"],
    ]);
  });

  it("does not mark a dataset or function name as broken", () => {
    const { model, diagnostics } = check("orders = [1]\nsum = [2]\nm = sum(orders.a)");
    expect(diagnostics).toHaveLength(2); // only the two syntax errors
    expect(model.measures.map((m) => m.name)).toEqual(["m"]);
  });

  it("sorts the diagnostics of the parser and the checker by position", () => {
    const d = check("a = [1]\nb = orders.nope\nc = 2 ** 3").diagnostics;
    expect(d.map((x) => x.line)).toEqual([1, 2, 3]);
  });
});

describe("relate", () => {
  it("collects relationships, many side first", () => {
    const { model, diagnostics } = check("relate(orders.b, customers.id)\nrelate(items.order_id, orders.a)");
    expect(diagnostics).toEqual([]);
    expect(model.relationships).toEqual([
      { many: { dataset: "orders", column: "b" }, one: { dataset: "customers", column: "id" }, span: { from: 0, to: 30, line: 1, col: 1 } },
      { many: { dataset: "items", column: "order_id" }, one: { dataset: "orders", column: "a" }, span: expect.anything() },
    ]);
  });

  it("accepts keyword arguments and unknown column lists", () => {
    expect(messages("relate(many=orders.b, one=customers.id)")).toEqual([]);
    expect(messages("relate(loose.x, customers.id)")).toEqual([]);
  });

  it("refuses two columns of one dataset", () => {
    expect(messages("relate(orders.a, orders.b)")).toEqual(["relate() needs columns of two different datasets, both are in orders"]);
  });

  it("refuses a duplicate and the reverse of an existing one, and leaves them out", () => {
    const dup = check("relate(orders.b, customers.id)\nrelate(orders.b, customers.id)");
    expect(dup.diagnostics.map((d) => [d.line, d.message])).toEqual([[2, "this relationship is already defined on line 1"]]);
    expect(dup.model.relationships).toHaveLength(1);
    const rev = check("relate(orders.b, customers.id)\nrelate(customers.id, orders.b)");
    expect(rev.diagnostics.map((d) => [d.line, d.message])).toEqual([[2, "this is the reverse of the relationship on line 1"]]);
    expect(rev.model.relationships).toHaveLength(1);
  });

  it("refuses a different column pair of the same two datasets: that would be a second path", () => {
    const { model, diagnostics } = check("relate(orders.b, customers.id)\nrelate(orders.a, customers.name)");
    expect(diagnostics.map((d) => [d.line, d.message])).toEqual([
      [2, "this relationship gives orders a second path to customers: orders.a → customers.name and orders.b → customers.id"],
    ]);
    expect(model.relationships).toHaveLength(1);
  });

  it("checks that the columns exist when known", () => {
    expect(messages("relate(orders.nope, customers.id)")).toEqual(["orders has no column nope"]);
    expect(messages("relate(orders.b, nope.id)")).toEqual(["unknown name nope"]);
    // relationships are read in the first pass, before the measures: of the names, only a param is known then
    expect(messages('rate = param("rate", 1)\nrelate(rate.b, customers.id)')).toEqual(["`rate` is not a dataset (datasets: orders, customers, items, loose)"]);
  });

  it("wants two columns", () => {
    expect(messages("relate(orders.a)")).toEqual(["relate() is missing `one`"]);
    expect(messages("relate(1, 2)")[0]).toContain("expected a column written dataset.column");
    expect(messages("relate(orders.a, customers.id, 3)")[0]).toBe("relate() takes 2 arguments, got 3");
  });

  it("is a line of its own, not a value", () => {
    expect(messages("x = relate(orders.b, customers.id)")).toEqual(["relate(...) has to be a line of its own"]);
  });
});

describe("the relationship graph", () => {
  const SNOW: Schema = { ...SCHEMA, regions: ["id"], stores: ["id", "region_id"], goals: ["region_id"] };
  const snow = (source: string) => check(source, SNOW);

  it("accepts a snowflake and two facts sharing a dimension", () => {
    const { model, diagnostics } = snow(
      ["relate(items.order_id, orders.a)", "relate(orders.b, customers.id)", "relate(customers.name, regions.id)", "relate(goals.region_id, regions.id)"].join("\n"),
    );
    expect(diagnostics).toEqual([]);
    expect(model.relationships).toHaveLength(4);
  });

  it("refuses a cycle, naming the relationship and the way back, and leaves it out", () => {
    const { model, diagnostics } = check("relate(orders.b, customers.id)\nrelate(customers.name, orders.a)");
    expect(diagnostics.map((d) => [d.line, d.message])).toEqual([
      [2, "this relationship creates a cycle: customers.name → orders.a and, the other way, orders.b → customers.id"],
    ]);
    expect(model.relationships).toHaveLength(1);
  });

  it("refuses a cycle through several datasets", () => {
    const d = snow("relate(items.order_id, orders.a)\nrelate(orders.b, customers.id)\nrelate(customers.name, items.qty)").diagnostics;
    expect(d.map((x) => x.line)).toEqual([3]);
    expect(d[0].message).toContain("creates a cycle");
    expect(d[0].message).toContain("items.order_id → orders.a then orders.b → customers.id");
  });

  it("refuses a second path, naming both, and leaves the relationship out", () => {
    const { model, diagnostics } = snow(
      ["relate(orders.a, stores.id)", "relate(stores.region_id, regions.id)", "relate(orders.b, customers.id)", "relate(customers.name, regions.id)"].join("\n"),
    );
    expect(diagnostics.map((d) => [d.line, d.message])).toEqual([
      [
        4,
        "this relationship gives orders a second path to regions: orders.b → customers.id then customers.name → regions.id" +
          " and orders.a → stores.id then stores.region_id → regions.id",
      ],
    ]);
    expect(model.relationships.map((r) => r.span.line)).toEqual([1, 2, 3]);
  });

  it("underlines the whole relate call", () => {
    expect(check("relate(orders.b, customers.id)\nrelate(customers.name, orders.a)").diagnostics[0]).toMatchObject({ line: 2, col: 1, from: 31, to: 63 });
  });

  it("checks the graph with the relationships that were kept, not the ones refused", () => {
    // line 2 is refused (a cycle), so line 3 is not one too
    const d = check("relate(orders.b, customers.id)\nrelate(customers.name, orders.a)\nrelate(items.order_id, orders.a)").diagnostics;
    expect(d.map((x) => x.line)).toEqual([2]);
  });
});

describe("the two passes", () => {
  it("reads relate, calendar and param lines first, so a measure can use what is declared below it", () => {
    const source = [
      "m = calculate(sum(items.qty), orders.status == \"x\")",
      "n = ytd(sum(orders.a)) * rate",
      "k = calculate(sum(orders.a), dates.year == 2024)",
      "relate(items.order_id, orders.a)",
      "dates = calendar(orders.day)",
      'rate = param("rate", 2)',
    ].join("\n");
    const { model, diagnostics } = check(source);
    expect(diagnostics).toEqual([]);
    expect(model.measures.map((x) => x.name)).toEqual(["m", "n", "k"]);
    expect(model.relationships).toHaveLength(2);
    expect(model.calendars.map((c) => c.name)).toEqual(["dates"]);
    expect(model.params.map((p) => p.name)).toEqual(["rate"]);
  });

  it("has no calendars or params when the file declares none", () => {
    const { model } = check("m = sum(orders.a)");
    expect(model.calendars).toEqual([]);
    expect(model.params).toEqual([]);
  });

  it("still needs an earlier line for a name that is not declared in the first pass", () => {
    expect(messages("m = n + 1\nn = 2")).toEqual(["unknown name n"]);
    expect(messages('m = sum(orders.a) * k\nk = param("k", 2)')).toEqual([]);
  });

  it("gives a name to the line that came first, whatever the pass", () => {
    const d = (source: string) => check(source).diagnostics.map((x) => [x.line, x.message]);
    expect(d('x = sum(orders.a)\nx = param("x", 1)')).toEqual([[2, "`x` is already defined"]]);
    expect(d('x = param("x", 1)\nx = sum(orders.a)')).toEqual([[2, "`x` is already defined"]]);
    expect(d("x = sum(orders.a)\nx = calendar(orders.day)")).toEqual([[2, "`x` is already defined"]]);
    expect(d("x = [1]\nx = calendar(orders.day)")[1]).toEqual([2, "`x` is already defined"]);
    expect(check('x = sum(orders.a)\nx = param("x", 1)').model.measures.map((m) => m.name)).toEqual(["x"]);
    expect(check('x = sum(orders.a)\nx = param("x", 1)').model.params).toEqual([]);
  });

  it("reports the errors of both passes together, in order of position", () => {
    const d = check('m = sum(orders.nope)\nrelate(orders.nope, customers.id)\nrate = param("rate", None)').diagnostics;
    expect(d.map((x) => x.line)).toEqual([1, 2, 3]);
  });

  it("leaves a declaration with an error out and keeps the rest", () => {
    const { model, diagnostics } = check('relate(orders.nope, customers.id)\nrate = param("rate", None)\nm = sum(orders.a)');
    expect(diagnostics).toHaveLength(2);
    expect(model.relationships).toEqual([]);
    expect(model.measures.map((x) => x.name)).toEqual(["m"]);
  });

  it("lists the params in file order, whichever pass found them", () => {
    const source = 'a = sum(orders.a) * param("first", 1)\nsecond = param("second", 2)\nb = sum(orders.a) * param("third", 3)';
    expect(check(source).model.params.map((p) => p.name)).toEqual(["first", "second", "third"]);
  });
});

describe("expression statements", () => {
  it("must be relate(...)", () => {
    for (const src of ["sum(orders.a)", "1 + 2", "orders.a", "orders", "nope(1)", "'text'"]) {
      expect(messages(src)).toEqual([ALLOWED]);
    }
  });
});

describe("never throws", () => {
  it("turns whatever goes wrong into diagnostics", () => {
    for (const src of ["", "\0", "((((", "x = ", "from", "@", "x = " + "1+".repeat(20000) + "1", "x = sum(" + "1+".repeat(30000) + "1)"]) {
      expect(() => check(src)).not.toThrow();
    }
    expect(check("x = " + "1+".repeat(20000) + "1").model.measures).toEqual([]);
  });
});
