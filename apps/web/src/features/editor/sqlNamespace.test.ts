import { describe, expect, it } from "vitest";

import { sqlNamespace } from "./sqlNamespace";

const cols = (...names: string[]) => names.map((name) => ({ name }));

describe("sqlNamespace", () => {
  it("lists a table of the default catalog's main at the top, and its other schemas as namespaces", () => {
    expect(sqlNamespace({ orders: cols("a"), "tpch.lineitem": cols("b"), "main.x": cols("c") })).toEqual({
      orders: ["a"],
      x: ["c"],
      tpch: { lineitem: ["b"] },
    });
  });

  it("nests a table of another catalog under catalog, schema and table", () => {
    expect(sqlNamespace({ "sales.main.orders": cols("d"), "sales.raw.events": cols("e") })).toEqual({
      sales: { main: { orders: ["d"] }, raw: { events: ["e"] } },
    });
  });

  it("completes the default catalog's full names too, when the table names include it", () => {
    expect(sqlNamespace({ orders: cols("a"), "tpch.main.orders": cols("a") })).toEqual({
      orders: ["a"],
      tpch: { main: { orders: ["a"] } },
    });
  });

  it("makes a namespace win a clash with a table, whichever comes first", () => {
    expect(sqlNamespace({ x: cols("a"), "x.y": cols("b") })).toEqual({ x: { y: ["b"] } });
    expect(sqlNamespace({ "x.y": cols("b"), x: cols("a") })).toEqual({ x: { y: ["b"] } });
  });

  it("is empty for a catalog without tables", () => {
    expect(sqlNamespace({})).toEqual({});
  });
});
