import { describe, expect, it } from "vitest";

import { parseOntology } from "@/lib/ontology";

import type { ToolContext } from "../ai/tools";
import { DATA_TOOLS, dataTools, runDataTool } from "./tools";

const TABLES = [{ name: "orders", full: "main.sales.orders", path: "orders.parquet", format: "parquet" }];

/** A context whose kernel answers the catalog and fails the queries given in `fails`. */
function fake(fails: Record<string, string> = {}): ToolContext {
  const request = async (method: string) => {
    if (fails[method]) return { type: "error", ename: "Plan", evalue: fails[method], traceback: "" };
    switch (method) {
      case "catalog.list":
        return TABLES;
      case "catalog.table":
        return { ...TABLES[0], columns: [{ name: "id", type: "int64", nullable: false }], num_rows: 7 };
      case "sql.run":
        return { type: "table", result: { id: "r1", columns: [{ name: "id", type: "int64" }], num_rows: 1 } };
      case "result.page":
        return { offset: 0, total: 1, rows: [[1]] };
      default:
        return {};
    }
  };
  return { request: request as unknown as ToolContext["request"], allow: null };
}

describe("DATA_TOOLS", () => {
  it("declares the data tools with JSON Schema parameters", () => {
    expect(DATA_TOOLS.map((t) => t.name)).toEqual(["list_tables", "describe_table", "explain_sql", "run_sql", "list_files", "read_file", "search_ontology"]);
    for (const t of DATA_TOOLS) {
      expect(t.type).toBe("function");
      expect(t.description).toMatch(/\S/);
      expect(t.parameters).toMatchObject({ type: "object" });
      expect(t.parameters).not.toHaveProperty("$schema");
      expect(t.parameters).not.toHaveProperty("additionalProperties");
    }
    expect(DATA_TOOLS[1].parameters).toMatchObject({ properties: { name: { type: "string" } }, required: ["name"] });
    expect(DATA_TOOLS[3].parameters).toMatchObject({ properties: { sql: { type: "string" }, max_rows: { type: "integer", minimum: 1, maximum: 500 } }, required: ["sql"] });
  });

  it("picks the tools by name", () => {
    expect(dataTools(["run_sql", "list_tables"]).map((t) => t.name)).toEqual(["list_tables", "run_sql"]);
    expect(dataTools([])).toEqual([]);
  });
});

describe("runDataTool", () => {
  it("runs a tool and gives its result as JSON text", async () => {
    const out = await runDataTool(fake(), "list_tables", {});
    expect(out).toEqual({ text: JSON.stringify([{ name: "orders", full: "main.sales.orders", format: "parquet" }]), isError: false, use: { tool: "list_tables" } });
  });

  it("names the table of describe_table as the target", async () => {
    const out = await runDataTool(fake(), "describe_table", { name: "orders" });
    expect(out.isError).toBe(false);
    expect(out.use).toEqual({ tool: "describe_table", target: "orders" });
    expect(JSON.parse(out.text)).toMatchObject({ full: "main.sales.orders", num_rows: 7 });
  });

  it("gives bad arguments back as an error result", async () => {
    const out = await runDataTool(fake(), "describe_table", { table: "orders" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/name/);
    expect(out.use).toEqual({ tool: "describe_table" });
    expect((await runDataTool(fake(), "run_sql", { sql: "SELECT 1", max_rows: 100_000 })).isError).toBe(true);
  });

  it("takes missing arguments as none", async () => {
    expect((await runDataTool(fake(), "list_tables", undefined)).isError).toBe(false);
  });

  it("gives a refused query back as an error result, never a throw", async () => {
    const out = await runDataTool(fake({ "sql.run": "no read grant on table x" }), "run_sql", { sql: "SELECT * FROM x" });
    expect(out).toEqual({ text: "Plan: no read grant on table x", isError: true, use: { tool: "run_sql" } });
    expect((await runDataTool(fake(), "describe_table", { name: "nope" })).text).toBe("there is no table nope you can read");
  });

  it("gives the terms search_ontology found as knowledge, within the user's grants", async () => {
    const finance = parseOntology(
      "finance",
      `[ontology]\nname = "Finance"\n[[term]]\nname = "Net revenue"\ndescription = "${"after discounts ".repeat(30)}"\ncertified = true\ncolumns = ["main.sales.orders.amount"]\n[[term]]\nname = "Gross revenue"\ndescription = "before discounts"\ncolumns = ["main.secret.ledger.amount"]`,
    );
    const ctx = (allow: string[] | null): ToolContext => ({ ...fake(), allow, ontologies: async () => ({ ontologies: [finance], problems: [] }) });

    const out = await runDataTool(ctx(["main.sales"]), "search_ontology", { query: " revenue " });
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.text).terms.map((t: { name: string }) => t.name)).toEqual(["Net revenue"]);
    expect(out.use).toEqual({ tool: "search_ontology", target: "revenue", knowledge: [{ team: "Finance", term: "Net revenue", certified: true, description: "after discounts ".repeat(30).trim().slice(0, 240) }] });

    expect(JSON.parse((await runDataTool(ctx(null), "search_ontology", { query: "revenue" })).text).terms).toHaveLength(2);
    // nothing found, and no ontology at all: no knowledge, no target for an empty query
    expect((await runDataTool(ctx(null), "search_ontology", { query: "weather" })).use).toEqual({ tool: "search_ontology", target: "weather" });
    expect(await runDataTool(fake(), "search_ontology", { query: "" })).toEqual({ text: JSON.stringify({ terms: [], joins: [], more: 0 }), isError: false, use: { tool: "search_ontology" } });
  });

  it("tells of the ontology files that are broken when the context gives them", async () => {
    const ctx: ToolContext = { ...fake(), ontologies: async () => ({ ontologies: [], problems: [{ team: "ops", message: "not valid TOML" }] }) };
    expect(JSON.parse((await runDataTool(ctx, "search_ontology", { query: "x" })).text).problems).toEqual(["ops.toml could not be read: not valid TOML"]);
  });

  it("gives an unknown tool back as an error result", async () => {
    expect(await runDataTool(fake(), "drop_table", {})).toEqual({ text: "unknown tool: drop_table", isError: true, use: { tool: "drop_table" } });
  });
});
