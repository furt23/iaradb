import { describe, expect, it } from "vitest";

import { MAX_SHOWN, groupTables, schemaKeyOf, tableNameOf, visibleTables } from "./tableTree";

const NAMES = ["sales.tpch.orders", "demo.main.nation", "demo.tpch.lineitem", "demo.tpch.Orders_2", "demo.sales.invoice"];

describe("groupTables", () => {
  it("groups by catalog and schema, sorted, with the tables sorted", () => {
    expect(groupTables(NAMES, "", null)).toEqual([
      { catalog: "demo", schemas: [
        { schema: "main", tables: ["demo.main.nation"] },
        { schema: "sales", tables: ["demo.sales.invoice"] },
        { schema: "tpch", tables: ["demo.tpch.Orders_2", "demo.tpch.lineitem"] },
      ] },
      { catalog: "sales", schemas: [{ schema: "tpch", tables: ["sales.tpch.orders"] }] },
    ]);
  });

  it("matches the query anywhere in the full name, ignoring case", () => {
    const found = groupTables(NAMES, "ORDER", null).flatMap((c) => c.schemas.flatMap((s) => s.tables));
    expect(found).toEqual(["demo.tpch.Orders_2", "sales.tpch.orders"]);
    expect(groupTables(NAMES, "  sales  ", null).flatMap((c) => c.catalog)).toEqual(["demo", "sales"]);
  });

  it("keeps only the given names when onlyIncluded is set", () => {
    const only = new Set(["demo.main.nation"]);
    expect(groupTables(NAMES, "", only)).toEqual([{ catalog: "demo", schemas: [{ schema: "main", tables: ["demo.main.nation"] }] }]);
  });

  it("returns nothing for a query no name matches", () => {
    expect(groupTables(NAMES, "zzz", null)).toEqual([]);
  });
});

describe("visibleTables", () => {
  const groups = groupTables(NAMES, "", null);
  const all = () => true;

  it("shows the tables of the open schemas only", () => {
    const { visible, truncated } = visibleTables(groups, (key) => key === "demo.main");
    expect([...visible]).toEqual(["demo.main.nation"]);
    expect(truncated).toBe(false);
  });

  it("stops at the limit and says so", () => {
    const { visible, truncated } = visibleTables(groups, all, 3);
    expect(visible.size).toBe(3);
    expect(truncated).toBe(true);
  });

  it("does not flag a truncation when everything fits the limit", () => {
    const { visible, truncated } = visibleTables(groups, all, MAX_SHOWN);
    expect(visible.size).toBe(NAMES.length);
    expect(truncated).toBe(false);
  });
});

describe("names", () => {
  it("reads the schema key and the table's short name", () => {
    expect(schemaKeyOf("demo.tpch.orders")).toBe("demo.tpch");
    expect(tableNameOf("demo.tpch.orders")).toBe("orders");
  });
});
