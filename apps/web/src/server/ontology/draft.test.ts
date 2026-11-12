import { describe, expect, it, vi } from "vitest";

import type { ToolContext } from "../ai/tools";
import { draftOntology, MAX_TABLES, type DraftRequest } from "./draft";

const COLUMNS: Record<string, { name: string; type: string }[]> = {
  orders: [
    { name: "id", type: "int64" },
    { name: "customer_id", type: "int64" },
    { name: "amount", type: "float64" },
  ],
  customers: [
    { name: "id", type: "int64" },
    { name: "name", type: "utf8" },
  ],
  salaries: [{ name: "amount", type: "float64" }],
};
const TABLES = [
  { name: "orders", full: "main.sales.orders", path: "", format: "parquet" },
  { name: "customers", full: "main.sales.customers", path: "", format: "parquet" },
  { name: "salaries", full: "main.hr.salaries", path: "", format: "parquet" },
];

/** A kernel with three tables; `sql.run` fails with `noCluster` when given. */
function tools(opts: { allow?: string[] | null; noCluster?: string; tables?: typeof TABLES } = {}): ToolContext & { queries: string[] } {
  const queries: string[] = [];
  const request = async (method: string, params: { name?: string; query?: string }) => {
    switch (method) {
      case "catalog.list":
        return opts.tables ?? TABLES;
      case "catalog.table":
        return { name: params.name, full: (opts.tables ?? TABLES).find((t) => t.name === params.name)!.full, columns: COLUMNS[params.name!] ?? [], num_rows: 7 };
      case "sql.run":
        queries.push(params.query!);
        if (opts.noCluster) return { type: "error", ename: "Cluster", evalue: opts.noCluster, traceback: "" };
        return { type: "table", result: { id: "r1", columns: [], num_rows: 2 } };
      case "result.page":
        return { offset: 0, total: 2, rows: [[1, 10, 99.5], [2, 11, "x".repeat(100)]] };
      default:
        return {};
    }
  };
  return { request: request as unknown as ToolContext["request"], allow: opts.allow ?? null, queries };
}

const REQ: DraftRequest = { scope: ["main.sales"], samples: false, existing: [], language: "pt" };
const ANSWER = {
  terms: [
    { name: "Receita", description: "Soma dos pedidos.", synonyms: ["revenue"], columns: ["main.sales.orders.amount"], sql: "sum(amount)" },
    { name: "Salário", description: "Não está no escopo.", synonyms: [], columns: ["main.hr.salaries.amount"], sql: "" },
  ],
  joins: [{ left: "main.sales.orders.customer_id", right: "main.sales.customers.id", description: "cada pedido tem um cliente" }],
};

describe("draftOntology", () => {
  it("drafts from the tables in scope and keeps only what they support", async () => {
    const llm = vi.fn(async () => ANSWER);
    const out = await draftOntology({ llm, tools: tools(), files: async () => [] }, REQ);
    expect(out.tables).toEqual(["main.sales.orders", "main.sales.customers"]);
    expect(out.terms.map((t) => t.name)).toEqual(["Receita"]);
    expect(out.joins).toHaveLength(1);
    expect(out).toMatchObject({ dropped: 1, sampled: false, sampleError: null });

    const [, system, prompt, schema] = llm.mock.calls[0] as unknown as [string, string, string, object];
    expect(system).toMatch(/^You draft a team's ontology/);
    expect(prompt).toContain("Brazilian Portuguese");
    expect(prompt).toContain("main.sales.orders (7 rows)\n  id int64\n  customer_id int64\n  amount float64");
    expect(prompt).not.toContain("salaries");
    expect(schema).toMatchObject({ required: ["terms", "joins"] });
  });

  it("reads only the tables the user has a grant on", async () => {
    const llm = vi.fn(async () => ANSWER);
    const out = await draftOntology({ llm, tools: tools({ allow: ["main.sales.orders"] }), files: async () => [] }, { ...REQ, scope: ["*"] });
    expect(out.tables).toEqual(["main.sales.orders"]);
    // the join's other side is a table the user may not read
    expect(out.joins).toEqual([]);
    await expect(draftOntology({ llm, tools: tools({ allow: [] }), files: async () => [] }, REQ)).rejects.toThrow(/no table you can read/);
  });

  it("gives the model a few values of each column when rows can be read", async () => {
    const llm = vi.fn(async () => ANSWER);
    const t = tools();
    const out = await draftOntology({ llm, tools: t, files: async () => [] }, { ...REQ, samples: true });
    expect(out.sampled).toBe(true);
    expect(t.queries).toHaveLength(2);
    expect(t.queries[0]).toContain("SELECT * FROM main.sales.orders LIMIT 3");
    const prompt = (llm.mock.calls[0] as unknown as string[])[2];
    expect(prompt).toContain("id int64 e.g. 1 | 2");
    expect(prompt).toContain(`amount float64 e.g. 99.5 | ${"x".repeat(40)}…`);
  });

  it("goes on from the columns when no cluster runs, and says why", async () => {
    const llm = vi.fn(async () => ANSWER);
    const t = tools({ noCluster: "start a cluster first" });
    const out = await draftOntology({ llm, tools: t, files: async () => [] }, { ...REQ, samples: true });
    expect(out).toMatchObject({ sampled: false, sampleError: "Cluster: start a cluster first" });
    // the first failure ends the sampling
    expect(t.queries).toHaveLength(1);
    expect(out.terms).toHaveLength(1);
  });

  it("shows the model the queries people wrote over the tables, and the terms that exist", async () => {
    const llm = vi.fn(async () => ANSWER);
    const files = async () => [
      { path: "revenue.sql", text: "SELECT sum(amount) FROM sales.orders" },
      { path: "other.sql", text: "SELECT * FROM preorders" },
    ];
    await draftOntology({ llm, tools: tools(), files }, { ...REQ, existing: ["Ticket médio"] });
    const prompt = (llm.mock.calls[0] as unknown as string[])[2];
    expect(prompt).toContain("-- revenue.sql\nSELECT sum(amount) FROM sales.orders");
    expect(prompt).not.toContain("other.sql");
    expect(prompt).toContain("- Ticket médio");
  });

  it("asks in batches for many tables, and a later batch does not repeat an earlier one", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, full: `main.big.t${i}`, path: "", format: "parquet" }));
    const llm = vi.fn(async () => ({ terms: [{ name: "Fiscal year", description: "Starts in April.", synonyms: [], columns: [], sql: "" }], joins: [] }));
    const out = await draftOntology({ llm, tools: tools({ tables: many }), files: async () => [] }, { ...REQ, scope: ["main.big"] });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(out.terms).toHaveLength(1);
    expect(out.dropped).toBe(1);
    const second = (llm.mock.calls[1] as unknown as string[])[2];
    expect(second).toContain("- Fiscal year");
    expect(second).toContain("Every table in scope, for joins");
  });

  it("refuses an empty scope and more tables than one draft reads", async () => {
    const llm = vi.fn();
    await expect(draftOntology({ llm, tools: tools(), files: async () => [] }, { ...REQ, scope: [" "] })).rejects.toThrow(/choose/);
    const many = Array.from({ length: MAX_TABLES + 1 }, (_, i) => ({ name: `t${i}`, full: `main.big.t${i}`, path: "", format: "parquet" }));
    await expect(draftOntology({ llm, tools: tools({ tables: many }), files: async () => [] }, { ...REQ, scope: ["main"] })).rejects.toThrow(/at most 40/);
    expect(llm).not.toHaveBeenCalled();
  });
});
