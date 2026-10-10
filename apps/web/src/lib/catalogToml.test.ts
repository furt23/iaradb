import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

import {
  displayName,
  isIdentifier,
  parseTableName,
  removeSchemaSection,
  removeTableSection,
  schemaEntry,
  schemasOf,
  suggestTableName,
  tableEntry,
  tablesOf,
} from "./catalogToml";

const TOML = `# the catalog
[workspace]
name = "demo"

[tables.sales]
path = "data/sales.parquet"

# regions come from a CSV
[tables.regions]
path = "data/regions.csv"

[tables.events]
path = "s3://bucket/events/"
format = "parquet"

[storage."s3://bucket"]
region = "us-east-1"
`;

const SCHEMAS = `[schemas.tpch]
description = "TPC-H benchmark"

[tables.tpch.lineitem]
path = "warehouse/tpch/lineitem"

# orders are a CSV
[tables."tpch.orders"]
path = "data/orders.csv"

[tables.tpch.lineitem_sf10]
path = "warehouse/tpch/lineitem_sf10"
`;

const names = (text: string) => tablesOf(parse(text)).map((t) => t.name);

describe("tablesOf", () => {
  it("reads every table in main, with the format the kernel infers", () => {
    expect(tablesOf(parse(TOML))).toEqual([
      { name: "sales", schema: "main", table: "sales", path: "data/sales.parquet", format: "parquet" },
      { name: "regions", schema: "main", table: "regions", path: "data/regions.csv", format: "csv" },
      { name: "events", schema: "main", table: "events", path: "s3://bucket/events/", format: "parquet" },
    ]);
  });

  it("reads the tables of a schema, dotted or quoted", () => {
    expect(tablesOf(parse(SCHEMAS))).toEqual([
      { name: "tpch.lineitem", schema: "tpch", table: "lineitem", path: "warehouse/tpch/lineitem", format: "parquet" },
      { name: "tpch.lineitem_sf10", schema: "tpch", table: "lineitem_sf10", path: "warehouse/tpch/lineitem_sf10", format: "parquet" },
      { name: "tpch.orders", schema: "tpch", table: "orders", path: "data/orders.csv", format: "csv" },
    ]);
  });

  it("reads main.orders as a table in main, and a sub-section of a schema as its table", () => {
    const cfg = parse('[tables.main.orders]\npath = "a.parquet"\n[tables.sales.orders]\npath = "b.parquet"\n');
    expect(tablesOf(cfg).map((t) => [t.name, t.schema])).toEqual([
      ["orders", "main"],
      ["sales.orders", "sales"],
    ]);
  });

  it("lowercases the names, as the kernel registers them", () => {
    expect(names('[tables.Sales]\npath = "a"\n[tables.TPCH.Lineitem]\npath = "b"\n')).toEqual(["sales", "tpch.lineitem"]);
  });

  it("uses the format given, and infers it from the extension otherwise", () => {
    const cfg = parse('[tables.a]\npath = "x.csv"\nformat = "parquet"\n[tables.b]\npath = "y.PARQUET"\nformat = "tsv"\n');
    expect(tablesOf(cfg).map((t) => t.format)).toEqual(["parquet", "parquet"]);
  });

  it("ignores files without tables and entries that are not tables", () => {
    expect(tablesOf({})).toEqual([]);
    expect(tablesOf(null)).toEqual([]);
    expect(tablesOf({ tables: { x: { format: "csv" } } })).toEqual([]);
    expect(tablesOf(parse('[tables.tpch]\nnote = "x"\n[tables.tpch.bad]\nformat = "csv"\n'))).toEqual([]);
  });

  it("is an error for a table that also has sub-tables", () => {
    const text = '[tables.events]\npath = "x"\n[tables.events.options]\nregion = "y"\n';
    expect(() => tablesOf(parse(text))).toThrow("tables.events is both a table and a schema");
  });

  it("is an error for a table of a schema that has sub-tables", () => {
    const text = '[tables.tpch.lineitem]\npath = "x"\n[tables.tpch.lineitem.options]\nregion = "y"\n';
    expect(() => tablesOf(parse(text))).toThrow("tables.tpch.lineitem is both a table and a schema");
  });

  it("is an error for a table defined twice (dotted and quoted)", () => {
    const text = '[tables.tpch.lineitem]\npath = "a"\n[tables."tpch.lineitem"]\npath = "b"\n';
    expect(() => tablesOf(parse(text))).toThrow("table tpch.lineitem is defined twice");
  });
});

describe("schemasOf", () => {
  it("is main alone for a catalog without schemas", () => {
    expect(schemasOf("")).toEqual([{ name: "main", description: null }]);
    expect(schemasOf(TOML)).toEqual([{ name: "main", description: null }]);
  });

  it("lists the declared schemas and those used by a table, main first, by name", () => {
    const text = `${SCHEMAS}\n[schemas.empty]\n\n[tables.sales.orders]\npath = "b.parquet"\n\n[tables.orders]\npath = "c.parquet"\n`;
    expect(schemasOf(text)).toEqual([
      { name: "main", description: null },
      { name: "empty", description: null },
      { name: "sales", description: null },
      { name: "tpch", description: "TPC-H benchmark" },
    ]);
  });

  it("takes a description for main when it is declared", () => {
    expect(schemasOf('[schemas.main]\ndescription = "the default"\n')).toEqual([{ name: "main", description: "the default" }]);
  });
});

describe("table names", () => {
  it("splits a name into schema and table, lowercased", () => {
    expect(parseTableName("orders")).toEqual({ schema: "main", table: "orders" });
    expect(parseTableName("main.orders")).toEqual({ schema: "main", table: "orders" });
    expect(parseTableName("TPCH.LineItem")).toEqual({ schema: "tpch", table: "lineitem" });
  });

  it("rejects names that are not schema.table with identifier parts", () => {
    for (const bad of ["", ".orders", "tpch.", "a.b.c", "1x", "x-y", "a b", "tpch.1x"]) {
      expect(parseTableName(bad), bad).toBeNull();
    }
  });

  it("displays a table of main by its bare name, others as schema.table", () => {
    expect(displayName({ schema: "main", table: "orders" })).toBe("orders");
    expect(displayName({ schema: "tpch", table: "lineitem" })).toBe("tpch.lineitem");
  });

  it("checks identifiers", () => {
    expect(isIdentifier("tpch_2")).toBe(true);
    expect(isIdentifier("2tpch")).toBe(false);
    expect(isIdentifier("")).toBe(false);
  });
});

describe("removeTableSection", () => {
  it("removes a section and keeps the rest, comments included", () => {
    const out = removeTableSection(TOML, "sales")!;
    expect(names(out)).toEqual(["regions", "events"]);
    expect(out).toContain("# the catalog");
    expect(out).toContain("# regions come from a CSV");
    expect(out).not.toMatch(/\n\n\n/);
  });

  it("removes a table of a schema, dotted or quoted, and nothing else", () => {
    const dotted = removeTableSection(SCHEMAS, "tpch.lineitem")!;
    expect(dotted).not.toContain("warehouse/tpch/lineitem\"");
    expect(dotted).toContain("[schemas.tpch]\ndescription = \"TPC-H benchmark\"");
    expect(names(dotted)).toEqual(["tpch.orders", "tpch.lineitem_sf10"]);
    expect(dotted).toContain("# orders are a CSV");

    const quoted = removeTableSection(SCHEMAS.replace("[tables.tpch.lineitem]", '[tables."tpch.lineitem"]'), "tpch.lineitem")!;
    expect(names(quoted)).toEqual(["tpch.orders", "tpch.lineitem_sf10"]);
  });

  it("removes the sub-sections of a table, and no other table", () => {
    const text = '[tables.tpch.lineitem]\npath = "a"\n\n[tables.tpch.lineitem.options]\nregion = "x"\n\n[tables.tpch.orders]\npath = "b"\n';
    const out = removeTableSection(text, "tpch.lineitem")!;
    expect(out).not.toContain("options");
    expect(out).not.toContain('path = "a"');
    expect(names(out)).toEqual(["tpch.orders"]);
  });

  it("does not touch tables whose names start the same", () => {
    const text = '[tables.lineitem]\npath = "a"\n\n[tables.lineitem_sf10]\npath = "b"\n';
    expect(names(removeTableSection(text, "lineitem")!)).toEqual(["lineitem_sf10"]);
  });

  it("does not touch schemas whose names start the same", () => {
    const text = '[tables.tpch.orders]\npath = "a"\n\n[tables.tpch2.orders]\npath = "b"\n\n[tables.tpch2.orders_old]\npath = "c"\n';
    expect(names(removeTableSection(text, "tpch.orders")!)).toEqual(["tpch2.orders", "tpch2.orders_old"]);
    expect(names(removeTableSection(text, "tpch2.orders")!)).toEqual(["tpch.orders", "tpch2.orders_old"]);
  });

  it("keeps the declaration of its schema", () => {
    const out = removeTableSection(SCHEMAS, "tpch.orders")!;
    expect(schemasOf(out)).toEqual([
      { name: "main", description: null },
      { name: "tpch", description: "TPC-H benchmark" },
    ]);
  });

  it("removes main.orders as orders, and matches names regardless of case", () => {
    const text = '[tables.orders]\npath = "a"\n\n[tables.tpch.orders]\npath = "b"\n';
    expect(names(removeTableSection(text, "main.orders")!)).toEqual(["tpch.orders"]);
    expect(names(removeTableSection('[tables.Orders]\npath = "a"\n', "ORDERS")!)).toEqual([]);
  });

  it("is null for tables the file does not define as a section", () => {
    expect(removeTableSection(TOML, "nope")).toBeNull();
    expect(removeTableSection(SCHEMAS, "tpch.nope")).toBeNull();
    expect(removeTableSection('tables = { inline = { path = "x" } }\n', "inline")).toBeNull();
  });

  it("keeps Windows line endings", () => {
    const out = removeTableSection(TOML.replace(/\n/g, "\r\n"), "regions")!;
    expect(out).toContain('[tables.sales]\r\npath = "data/sales.parquet"');
    expect(out).not.toContain("regions");
  });
});

describe("removeSchemaSection", () => {
  it("removes the declaration of a schema, and keeps its tables", () => {
    const out = removeSchemaSection(SCHEMAS, "tpch")!;
    expect(out).not.toContain("[schemas.tpch]");
    expect(out).not.toContain("TPC-H benchmark");
    expect(names(out)).toEqual(["tpch.lineitem", "tpch.lineitem_sf10", "tpch.orders"]);
  });

  it("does not touch the declarations of schemas whose names start the same", () => {
    const text = "[schemas.tpch]\n\n[schemas.tpch2]\ndescription = \"two\"\n";
    expect(removeSchemaSection(text, "tpch")).toBe('[schemas.tpch2]\ndescription = "two"\n');
  });

  it("is null for a schema that is not declared", () => {
    expect(removeSchemaSection(SCHEMAS, "sales")).toBeNull();
  });
});

describe("tableEntry", () => {
  it("writes a table of main as [tables.<name>]", () => {
    expect(tableEntry("orders", "data/orders.parquet")).toBe('\n[tables.orders]\npath = "data/orders.parquet"\n');
    expect(tableEntry("main.orders", "a.parquet")).toBe(tableEntry("orders", "a.parquet"));
  });

  it("writes a table of a schema as [tables.schema.table], with its format when given", () => {
    expect(tableEntry("tpch.lineitem", "warehouse/tpch/lineitem", "csv")).toBe(
      '\n[tables.tpch.lineitem]\npath = "warehouse/tpch/lineitem"\nformat = "csv"\n',
    );
  });

  it("writes text that reads back as the same table", () => {
    const entry = tableEntry("sales.orders", "data\\Daily \"Trips\".csv", "csv");
    expect(tablesOf(parse(`[workspace]\nname = "x"\n${entry}`))).toEqual([
      { name: "sales.orders", schema: "sales", table: "orders", path: 'data\\Daily "Trips".csv', format: "csv" },
    ]);
  });

  it("is an error for an invalid name", () => {
    expect(() => tableEntry("a.b.c", "x")).toThrow("invalid table name a.b.c");
  });
});

describe("schemaEntry", () => {
  it("writes the section of a schema", () => {
    expect(schemaEntry("tpch")).toBe("\n[schemas.tpch]\n");
    expect(schemaEntry("TPCH")).toBe("\n[schemas.tpch]\n");
  });

  it("writes the description when there is one, and reads it back", () => {
    const entry = schemaEntry("tpch", 'TPC-H, "sf 1"');
    expect(schemasOf(`[workspace]\nname = "x"\n${entry}`)).toEqual([
      { name: "main", description: null },
      { name: "tpch", description: 'TPC-H, "sf 1"' },
    ]);
  });

  it("is an error for a name that is not an identifier", () => {
    expect(() => schemaEntry("bad-name")).toThrow("invalid schema name bad-name");
  });
});

describe("suggestTableName", () => {
  it("names a dataset after its file or folder", () => {
    expect(suggestTableName("data/sales.parquet")).toBe("sales");
    expect(suggestTableName("data/tpch/lineitem/")).toBe("lineitem");
    expect(suggestTableName("data\\Daily Trips.csv")).toBe("daily_trips");
    expect(suggestTableName("s3://bucket/2024-events/")).toBe("t_2024_events");
    expect(suggestTableName("data/events/*.parquet")).toBe("events");
    expect(suggestTableName("")).toBe("");
  });
});
