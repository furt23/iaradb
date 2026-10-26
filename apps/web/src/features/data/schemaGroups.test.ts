import { describe, expect, it } from "vitest";

import type { CatalogInfo, CatalogSchema, CatalogTable } from "@/lib/catalogToml";

import { catalogGroups, schemaGroups } from "./schemaGroups";

const DEFAULT: CatalogInfo = { name: "demo", description: null, isDefault: true };
const SALES: CatalogInfo = { name: "sales", description: "Sales", isDefault: false };

function table(catalog: string, schema: string, name: string): CatalogTable {
  const display = catalog === "demo" ? (schema === "main" ? name : `${schema}.${name}`) : `${catalog}.${schema}.${name}`;
  return { name: display, catalog, schema, table: name, full: `${catalog}.${schema}.${name}`, path: `${name}.parquet`, format: "parquet" };
}

const schema = (catalog: string, name: string, description: string | null = null): CatalogSchema => ({ catalog, name, description });

describe("schemaGroups", () => {
  it("puts main first, then the schemas by name, each with its tables by name", () => {
    const groups = schemaGroups(
      DEFAULT,
      [schema("demo", "main"), schema("demo", "tpch"), schema("demo", "sales")],
      [table("demo", "tpch", "orders"), table("demo", "main", "supplier"), table("demo", "tpch", "lineitem"), table("demo", "main", "nation")],
    );
    expect(groups.map((g) => [g.schema, g.name, g.tables.map((t) => t.name)])).toEqual([
      ["main", "main", ["nation", "supplier"]],
      ["sales", "sales", []],
      ["tpch", "tpch", ["tpch.lineitem", "tpch.orders"]],
    ]);
  });

  it("keeps declared schemas without tables, with their description", () => {
    const groups = schemaGroups(DEFAULT, [schema("demo", "staging", "raw files")], []);
    expect(groups.map((g) => [g.schema, g.description, g.tables])).toEqual([
      ["main", null, []],
      ["staging", "raw files", []],
    ]);
  });

  it("adds a schema used by a table, even when the list of schemas leaves it out", () => {
    const groups = schemaGroups(DEFAULT, [], [table("demo", "events", "clicks")]);
    expect(groups.map((g) => g.schema)).toEqual(["main", "events"]);
    expect(groups[1].tables).toEqual([table("demo", "events", "clicks")]);
  });

  it("is the main schema alone for an empty catalog", () => {
    expect(schemaGroups(DEFAULT, [], [])).toEqual([
      { catalog: "demo", schema: "main", name: "main", description: null, location: undefined, discoveryError: undefined, tables: [] },
    ]);
  });

  it("names the schemas of another catalog by catalog.schema, and leaves out the others' tables", () => {
    const groups = schemaGroups(SALES, [schema("sales", "raw", "landing")], [table("sales", "main", "orders"), table("demo", "main", "x")]);
    expect(groups.map((g) => [g.catalog, g.name, g.description, g.tables.map((t) => t.name)])).toEqual([
      ["sales", "sales.main", null, ["sales.main.orders"]],
      ["sales", "sales.raw", "landing", []],
    ]);
  });
});

describe("catalogGroups", () => {
  it("lists the catalogs as given, each with its own schemas", () => {
    const groups = catalogGroups(
      [DEFAULT, SALES],
      [schema("demo", "main"), schema("sales", "raw")],
      [table("demo", "main", "orders"), table("sales", "raw", "events")],
    );
    expect(groups.map((c) => [c.name, c.isDefault, c.description, c.schemas.map((s) => s.name)])).toEqual([
      ["demo", true, null, ["main"]],
      ["sales", false, "Sales", ["sales.main", "sales.raw"]],
    ]);
    expect(groups[1].schemas[1].tables.map((t) => t.name)).toEqual(["sales.raw.events"]);
  });
});
