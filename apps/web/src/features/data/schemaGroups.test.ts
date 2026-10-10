import { describe, expect, it } from "vitest";

import type { CatalogTable } from "@/lib/catalogToml";

import { schemaGroups } from "./schemaGroups";

function table(schema: string, name: string): CatalogTable {
  return { name: schema === "main" ? name : `${schema}.${name}`, schema, table: name, path: `${name}.parquet`, format: "parquet" };
}

describe("schemaGroups", () => {
  it("puts main first, then the schemas by name, each with its tables by name", () => {
    const groups = schemaGroups(
      [
        { name: "main", description: null },
        { name: "tpch", description: null },
        { name: "sales", description: null },
      ],
      [table("tpch", "orders"), table("main", "supplier"), table("tpch", "lineitem"), table("main", "nation")],
    );
    expect(groups.map((g) => [g.schema, g.tables.map((t) => t.name)])).toEqual([
      ["main", ["nation", "supplier"]],
      ["sales", []],
      ["tpch", ["tpch.lineitem", "tpch.orders"]],
    ]);
  });

  it("keeps declared schemas without tables, with their description", () => {
    const groups = schemaGroups([{ name: "staging", description: "raw files" }], []);
    expect(groups).toEqual([
      { schema: "main", description: null, tables: [] },
      { schema: "staging", description: "raw files", tables: [] },
    ]);
  });

  it("adds a schema used by a table, even when the list of schemas leaves it out", () => {
    const groups = schemaGroups([], [table("events", "clicks")]);
    expect(groups.map((g) => g.schema)).toEqual(["main", "events"]);
    expect(groups[1].tables).toEqual([table("events", "clicks")]);
  });

  it("is the main schema alone for an empty catalog", () => {
    expect(schemaGroups([], [])).toEqual([{ schema: "main", description: null, tables: [] }]);
  });
});
