import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

import {
  catalogEntry,
  catalogsOf,
  defaultCatalogOf,
  displayName,
  inCatalog,
  isIdentifier,
  normalizeCatalogName,
  parseTableName,
  removeCatalogHeader,
  removeCatalogSections,
  removeSchemaSection,
  removeTableSection,
  schemaDisplayName,
  schemaEntry,
  schemasOf,
  suggestTableName,
  tableEntry,
  tablesOf,
  withCatalogNames,
  withChange,
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

/** Two other catalogs: `sales` (described, with a schema `raw` and a table in it) and `archive` (empty). */
const CATALOGS = `[workspace]
name = "demo"

[tables.orders]
path = "data/orders.csv"

[catalogs.sales]
description = "Sales data"

[catalogs.sales.tables.orders]
path = "sales/orders.parquet"

[catalogs.sales.tables.raw.events]
path = "sales/raw/events/"
format = "parquet"

[catalogs.sales.schemas.raw]
description = "landing zone"
location = "s3://bucket/raw/"

[catalogs.archive]
`;

const names = (text: string) => tablesOf(parse(text)).map((t) => t.name);

describe("tablesOf", () => {
  it("reads every table in main, with the format the kernel infers", () => {
    expect(tablesOf(parse(TOML))).toEqual([
      { name: "sales", catalog: "demo", schema: "main", table: "sales", path: "data/sales.parquet", format: "parquet" },
      { name: "regions", catalog: "demo", schema: "main", table: "regions", path: "data/regions.csv", format: "csv" },
      { name: "events", catalog: "demo", schema: "main", table: "events", path: "s3://bucket/events/", format: "parquet" },
    ]);
  });

  it("reads the tables of a schema, dotted or quoted", () => {
    expect(tablesOf(parse(SCHEMAS))).toEqual([
      { name: "tpch.lineitem", catalog: "main", schema: "tpch", table: "lineitem", path: "warehouse/tpch/lineitem", format: "parquet" },
      { name: "tpch.lineitem_sf10", catalog: "main", schema: "tpch", table: "lineitem_sf10", path: "warehouse/tpch/lineitem_sf10", format: "parquet" },
      { name: "tpch.orders", catalog: "main", schema: "tpch", table: "orders", path: "data/orders.csv", format: "csv" },
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

  it("infers json from .json, .ndjson and .jsonl, and takes format = json", () => {
    const cfg = parse(
      [
        '[tables.a]\npath = "x.json"',
        '[tables.b]\npath = "y.NDJSON"',
        '[tables.c]\npath = "z.jsonl"',
        '[tables.d]\npath = "w"\nformat = "json"',
        '[tables.e]\npath = "v.json"\nformat = "parquet"',
      ].join("\n") + "\n",
    );
    expect(tablesOf(cfg).map((t) => t.format)).toEqual(["json", "json", "json", "json", "parquet"]);
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

  it("reads the tables of other catalogs as catalog.schema.table, main included", () => {
    expect(tablesOf(parse(CATALOGS)).map((t) => [t.name, t.catalog, t.schema, t.table])).toEqual([
      ["orders", "demo", "main", "orders"],
      ["sales.main.orders", "sales", "main", "orders"],
      ["sales.raw.events", "sales", "raw", "events"],
    ]);
  });

  it("is an error for a table of a catalog that is defined twice, or that has the default's name", () => {
    expect(() => tablesOf(parse('[workspace]\nname = "demo"\n[catalogs.demo.tables.x]\npath = "a"\n'))).toThrow(
      "catalog demo has the name of the default catalog",
    );
    expect(() => tablesOf(parse('[catalogs.Sales.tables.x]\npath = "a"\n[catalogs.sales.tables.x]\npath = "b"\n'))).toThrow(
      "catalog sales is defined twice",
    );
  });
});

describe("normalizeCatalogName", () => {
  it("lowercases, turns the characters outside a-z, 0-9 and _ into _", () => {
    expect(normalizeCatalogName("tpch_demo")).toBe("tpch_demo");
    expect(normalizeCatalogName("Iara Team")).toBe("iara_team");
    expect(normalizeCatalogName("sales-2024")).toBe("sales_2024");
    expect(normalizeCatalogName("Équipe")).toBe("_quipe");
    expect(normalizeCatalogName("   ")).toBe("___");
  });

  it("prefixes _ before a leading digit, and is main when empty", () => {
    expect(normalizeCatalogName("2024 data")).toBe("_2024_data");
    expect(normalizeCatalogName("")).toBe("main");
  });

  it("is the default catalog's name: the normalized [workspace] name, main without one", () => {
    expect(defaultCatalogOf(parse('[workspace]\nname = "Iara Team"\n'))).toBe("iara_team");
    expect(defaultCatalogOf(parse("[tables.x]\npath = \"a\"\n"))).toBe("main");
    expect(defaultCatalogOf(null)).toBe("main");
  });
});

describe("catalogsOf", () => {
  it("is the default catalog alone for a catalog without declared ones", () => {
    expect(catalogsOf("")).toEqual([{ name: "main", description: null, isDefault: true }]);
  });

  it("lists the default catalog first, then the declared ones by name, with their description", () => {
    expect(catalogsOf(CATALOGS)).toEqual([
      { name: "demo", description: null, isDefault: true },
      { name: "archive", description: null, isDefault: false },
      { name: "sales", description: "Sales data", isDefault: false },
    ]);
  });

  it("finds a catalog that is declared only by its sections", () => {
    expect(catalogsOf('[catalogs.sales.schemas.raw]\ndescription = "x"\n').map((c) => c.name)).toEqual(["main", "sales"]);
  });

  it("is an error for a catalog name that is not an identifier", () => {
    expect(() => catalogsOf('[catalogs."my-cat"]\n')).toThrow("catalog names are letters, digits and underscores: my-cat");
  });
});

describe("schemasOf", () => {
  it("is main alone for a catalog without schemas", () => {
    expect(schemasOf("")).toEqual([{ name: "main", catalog: "main", description: null }]);
    expect(schemasOf(TOML)).toEqual([{ name: "main", catalog: "demo", description: null }]);
  });

  it("lists the declared schemas and those used by a table, main first, by name", () => {
    const text = `${SCHEMAS}\n[schemas.empty]\n\n[tables.sales.orders]\npath = "b.parquet"\n\n[tables.orders]\npath = "c.parquet"\n`;
    expect(schemasOf(text)).toEqual([
      { name: "main", catalog: "main", description: null },
      { name: "empty", catalog: "main", description: null },
      { name: "sales", catalog: "main", description: null },
      { name: "tpch", catalog: "main", description: "TPC-H benchmark" },
    ]);
  });

  it("takes a description for main when it is declared", () => {
    expect(schemasOf('[schemas.main]\ndescription = "the default"\n')).toEqual([
      { name: "main", catalog: "main", description: "the default" },
    ]);
  });

  it("lists main, the declared schemas and the used ones of every catalog, the default first", () => {
    expect(schemasOf(CATALOGS)).toEqual([
      { name: "main", catalog: "demo", description: null },
      { name: "main", catalog: "archive", description: null },
      { name: "main", catalog: "sales", description: null },
      { name: "raw", catalog: "sales", description: "landing zone", location: "s3://bucket/raw/" },
    ]);
  });
});

describe("table names", () => {
  it("splits a name into catalog, schema and table, lowercased, the default catalog when none is named", () => {
    expect(parseTableName("orders", "demo")).toEqual({ catalog: "demo", schema: "main", table: "orders" });
    expect(parseTableName("main.orders", "demo")).toEqual({ catalog: "demo", schema: "main", table: "orders" });
    expect(parseTableName("TPCH.LineItem", "demo")).toEqual({ catalog: "demo", schema: "tpch", table: "lineitem" });
    expect(parseTableName("SALES.Raw.Events", "demo")).toEqual({ catalog: "sales", schema: "raw", table: "events" });
  });

  it("rejects names that are not 1 to 3 parts that are identifiers", () => {
    for (const bad of ["", ".orders", "tpch.", "a.b.c.d", "1x", "x-y", "a b", "tpch.1x", "a.b.1x"]) {
      expect(parseTableName(bad, "demo"), bad).toBeNull();
    }
  });

  it("displays a table of the default catalog's main by its bare name, its other schemas as schema.table, another catalog as catalog.schema.table", () => {
    expect(displayName({ catalog: "demo", schema: "main", table: "orders" }, "demo")).toBe("orders");
    expect(displayName({ catalog: "demo", schema: "tpch", table: "lineitem" }, "demo")).toBe("tpch.lineitem");
    expect(displayName({ catalog: "sales", schema: "main", table: "orders" }, "demo")).toBe("sales.main.orders");
  });

  it("names a table of a catalog by its catalog", () => {
    expect(inCatalog("orders", "Sales")).toBe("sales.main.orders");
    expect(inCatalog("raw.events", "sales")).toBe("sales.raw.events");
  });

  it("names a schema of a catalog by its catalog when it is not the default one", () => {
    expect(schemaDisplayName({ catalog: "demo", name: "tpch" }, "demo")).toBe("tpch");
    expect(schemaDisplayName({ catalog: "sales", name: "raw" }, "demo")).toBe("sales.raw");
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
      { name: "main", catalog: "main", description: null },
      { name: "tpch", catalog: "main", description: "TPC-H benchmark" },
    ]);
  });

  it("removes main.orders as orders, and matches names regardless of case", () => {
    const text = '[tables.orders]\npath = "a"\n\n[tables.tpch.orders]\npath = "b"\n';
    expect(names(removeTableSection(text, "main.orders")!)).toEqual(["tpch.orders"]);
    expect(names(removeTableSection('[tables.Orders]\npath = "a"\n', "ORDERS")!)).toEqual([]);
  });

  it("removes a table of another catalog by its catalog.schema.table name, and keeps the catalog", () => {
    expect(names(removeTableSection(CATALOGS, "sales.main.orders")!)).toEqual(["orders", "sales.raw.events"]);
    const out = removeTableSection(CATALOGS, "sales.raw.events")!;
    expect(catalogsOf(out).find((c) => c.name === "sales")?.description).toBe("Sales data");
    expect(names(out)).toEqual(["orders", "sales.main.orders"]);
  });

  it("is null for tables the file does not define as a section", () => {
    expect(removeTableSection(TOML, "nope")).toBeNull();
    expect(removeTableSection(SCHEMAS, "tpch.nope")).toBeNull();
    expect(removeTableSection(CATALOGS, "sales.main.nope")).toBeNull();
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

  it("removes the declaration of a schema of another catalog, named catalog.schema", () => {
    const out = removeSchemaSection(CATALOGS, "sales.raw")!;
    expect(schemasOf(out).find((s) => s.catalog === "sales" && s.name === "raw")).toEqual({
      name: "raw",
      catalog: "sales",
      description: null,
    });
    expect(catalogsOf(out).find((c) => c.name === "sales")?.description).toBe("Sales data");
  });

  it("is null for a schema that is not declared", () => {
    expect(removeSchemaSection(SCHEMAS, "sales")).toBeNull();
    expect(removeSchemaSection(CATALOGS, "archive.raw")).toBeNull();
  });
});

describe("removeCatalogSections and removeCatalogHeader", () => {
  it("removes a catalog with everything below it, and keeps the others", () => {
    const out = removeCatalogSections(CATALOGS, "sales")!;
    expect(catalogsOf(out).map((c) => c.name)).toEqual(["demo", "archive"]);
    expect(names(out)).toEqual(["orders"]);
    expect(out).toContain('[tables.orders]\npath = "data/orders.csv"');
  });

  it("removes only the catalog's own section, and keeps its tables and schemas", () => {
    const out = removeCatalogHeader(CATALOGS, "sales")!;
    expect(catalogsOf(out).find((c) => c.name === "sales")?.description).toBeNull();
    expect(names(out)).toEqual(["orders", "sales.main.orders", "sales.raw.events"]);
  });

  it("is null for a catalog the file does not declare", () => {
    expect(removeCatalogSections(TOML, "sales")).toBeNull();
    expect(removeCatalogHeader(TOML, "sales")).toBeNull();
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

  it("writes a table of another catalog as [catalogs.<c>.tables...], by its catalog.schema.table name or with the catalog given", () => {
    expect(tableEntry("sales.main.orders", "a.parquet")).toBe('\n[catalogs.sales.tables.orders]\npath = "a.parquet"\n');
    expect(tableEntry("orders", "a.parquet", undefined, "sales")).toBe(tableEntry("sales.main.orders", "a.parquet"));
    expect(tableEntry("raw.events", "a.parquet", "parquet", "sales")).toBe(
      '\n[catalogs.sales.tables.raw.events]\npath = "a.parquet"\nformat = "parquet"\n',
    );
  });

  it("writes text that reads back as the same table", () => {
    const entry = tableEntry("sales.orders", "data\\Daily \"Trips\".csv", "csv");
    expect(tablesOf(parse(`[workspace]\nname = "x"\n${entry}`))).toEqual([
      { name: "sales.orders", catalog: "x", schema: "sales", table: "orders", path: 'data\\Daily "Trips".csv', format: "csv" },
    ]);
    const other = tableEntry("raw.events", "a.parquet", undefined, "sales");
    expect(tablesOf(parse(`[workspace]\nname = "x"\n${other}`)).map((t) => t.name)).toEqual(["sales.raw.events"]);
  });

  it("is an error for an invalid name", () => {
    expect(() => tableEntry("a.b.c.d", "x")).toThrow("invalid table name a.b.c.d");
    expect(() => tableEntry("orders", "x", undefined, "bad-name")).toThrow("invalid table name orders");
  });
});

describe("schemaEntry and catalogEntry", () => {
  it("writes the section of a schema", () => {
    expect(schemaEntry("tpch")).toBe("\n[schemas.tpch]\n");
    expect(schemaEntry("TPCH")).toBe("\n[schemas.tpch]\n");
  });

  it("writes the description when there is one, and reads it back", () => {
    const entry = schemaEntry("tpch", 'TPC-H, "sf 1"');
    expect(schemasOf(`[workspace]\nname = "x"\n${entry}`)).toEqual([
      { name: "main", catalog: "x", description: null },
      { name: "tpch", catalog: "x", description: 'TPC-H, "sf 1"' },
    ]);
  });

  it("writes a schema of another catalog under [catalogs.<c>.schemas], with its location", () => {
    const entry = schemaEntry("raw", "landing", "s3://bucket/raw/", "sales");
    expect(entry).toBe('\n[catalogs.sales.schemas.raw]\ndescription = "landing"\nlocation = "s3://bucket/raw/"\n');
    expect(schemasOf(`[workspace]\nname = "x"\n${entry}`).find((s) => s.catalog === "sales" && s.name === "raw")).toEqual({
      name: "raw",
      catalog: "sales",
      description: "landing",
      location: "s3://bucket/raw/",
    });
  });

  it("is an error for a name that is not an identifier", () => {
    expect(() => schemaEntry("bad-name")).toThrow("invalid schema name bad-name");
    expect(() => schemaEntry("raw", null, null, "bad-name")).toThrow("invalid catalog name bad-name");
  });

  it("writes a catalog's section with its description, and reads it back", () => {
    expect(catalogEntry("Sales")).toBe("\n[catalogs.sales]\n");
    const entry = catalogEntry("sales", 'Sales, "EU"');
    expect(catalogsOf(`[workspace]\nname = "x"\n${entry}`)).toEqual([
      { name: "x", description: null, isDefault: true },
      { name: "sales", description: 'Sales, "EU"', isDefault: false },
    ]);
    expect(() => catalogEntry("bad-name")).toThrow("invalid catalog name bad-name");
  });
});

describe("withCatalogNames", () => {
  it("adds the full name of each table of the default catalog, and leaves the other names as they are", () => {
    expect(withCatalogNames({ orders: [1], "raw.events": [2], "sales.main.x": [3] }, "tpch")).toEqual({
      orders: [1],
      "raw.events": [2],
      "sales.main.x": [3],
      "tpch.main.orders": [1],
      "tpch.raw.events": [2],
    });
  });
});

describe("withChange", () => {
  const orders = (text: string) => tablesOf(parse(text)).find((t) => t.name === "orders")?.path;

  it("adds a table of another catalog under its catalog", () => {
    const entry = tableEntry("orders", "a.parquet", undefined, "archive");
    const out = withChange(TOML, { name: "archive.main.orders", entry });
    expect(names(out)).toContain("archive.main.orders");
    expect(catalogsOf(out).map((c) => c.name)).toEqual(["demo", "archive"]);
  });

  it("drops a table of another catalog, and keeps its catalog", () => {
    const out = withChange(CATALOGS, { name: "sales.main.orders", entry: null });
    expect(names(out)).toEqual(["orders", "sales.raw.events"]);
    expect(catalogsOf(out).find((c) => c.name === "sales")?.description).toBe("Sales data");
  });

  it("replaces a table that is declared already", () => {
    const out = withChange(CATALOGS, { name: "orders", entry: tableEntry("orders", "new.parquet") });
    expect(orders(out)).toBe("new.parquet");
    expect(names(out).filter((n) => n === "orders")).toHaveLength(1);
  });

  it("keeps a schema that is declared already (CREATE SCHEMA IF NOT EXISTS keeps its description)", () => {
    expect(withChange(CATALOGS, { kind: "schema", name: "sales.raw", entry: schemaEntry("raw", "other", null, "sales") })).toBe(CATALOGS);
  });

  it("drops a declared schema, and keeps its tables", () => {
    const out = withChange(CATALOGS, { kind: "schema", name: "sales.raw", entry: null });
    expect(schemasOf(out).find((s) => s.catalog === "sales" && s.name === "raw")?.description).toBeNull();
    expect(names(out)).toContain("sales.raw.events");
  });

  it("creates a catalog with its description, and keeps a catalog that is declared (CREATE CATALOG IF NOT EXISTS)", () => {
    const out = withChange(TOML, { kind: "catalog", name: "archive", entry: catalogEntry("archive", "old") });
    expect(catalogsOf(out).find((c) => c.name === "archive")?.description).toBe("old");
    expect(withChange(CATALOGS, { kind: "catalog", name: "sales", entry: catalogEntry("sales", "other") })).toBe(CATALOGS);
  });

  it("drops a catalog with all its sections", () => {
    const out = withChange(CATALOGS, { kind: "catalog", name: "sales", entry: null });
    expect(catalogsOf(out).map((c) => c.name)).toEqual(["demo", "archive"]);
    expect(names(out)).toEqual(["orders"]);
  });
});

describe("suggestTableName", () => {
  it("names a dataset after its file or folder", () => {
    expect(suggestTableName("data/sales.parquet")).toBe("sales");
    expect(suggestTableName("logs/events.ndjson")).toBe("events");
    expect(suggestTableName("data/tpch/lineitem/")).toBe("lineitem");
    expect(suggestTableName("data\\Daily Trips.csv")).toBe("daily_trips");
    expect(suggestTableName("s3://bucket/2024-events/")).toBe("t_2024_events");
    expect(suggestTableName("data/events/*.parquet")).toBe("events");
    expect(suggestTableName("")).toBe("");
  });
});
