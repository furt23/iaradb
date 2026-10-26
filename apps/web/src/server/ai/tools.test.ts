import { afterEach, describe, expect, it, vi } from "vitest";

import { describeTable, explainSql, listFiles, listTables, MAX_ROWS, readFile, runSql, TIMEOUT_MS, wrapQuery, type ToolContext } from "./tools";

vi.mock("../workspace/files", () => ({
  listTree: async () => [
    { name: "a.py", path: "a.py", kind: "notebook" },
    { name: "data.parquet", path: "data.parquet", kind: "data" },
    { name: "q", path: "q", kind: "dir", children: [{ name: "top.sql", path: "q/top.sql", kind: "sql" }, { name: "x.bin", path: "q/x.bin", kind: "other" }] },
  ],
  readText: async (rel: string) => ({ text: `text of ${rel}`, truncated: false }),
}));

type Call = { method: string; params: Record<string, unknown> };

const TABLES = [
  { name: "orders", full: "main.sales.orders", path: "orders.parquet", format: "parquet" },
  { name: "secret", full: "main.hr.secret", path: "secret.parquet", format: "csv" },
];

/** A context whose kernel answers with `answer` and records what it was asked. */
function fake(allow: string[] | null, answer: (method: string, params: Record<string, unknown>) => unknown = defaults) {
  const calls: Call[] = [];
  const request = (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return Promise.resolve(answer(method, params));
  };
  return { ctx: { request, allow } as unknown as ToolContext, calls };
}

function defaults(method: string): unknown {
  switch (method) {
    case "catalog.list":
      return TABLES;
    case "catalog.table":
      return { ...TABLES[0], columns: [{ name: "id", type: "int64", nullable: false }], num_rows: 7, files: 1, bytes: 1, stats: [] };
    case "sql.explain":
      return { text: "plan" };
    case "sql.run":
      return { type: "table", result: { id: "r1", columns: [{ name: "id", type: "int64" }], num_rows: 2 } };
    case "result.page":
      return { offset: 0, total: 3, rows: [[1], [2]] };
    default:
      return {};
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("wrapQuery", () => {
  it("wraps one statement as a subquery, without its semicolon", () => {
    expect(wrapQuery("SELECT 1;")).toBe("SELECT * FROM (\nSELECT 1\n) AS _d");
  });

  it("adds a LIMIT when given", () => {
    expect(wrapQuery("SELECT 1", 501)).toBe("SELECT * FROM (\nSELECT 1\n) AS _d\nLIMIT 501");
  });

  it("refuses more than one statement", () => {
    expect(() => wrapQuery("SELECT 1; DROP TABLE x")).toThrow("a dataset holds one query");
  });
});

describe("listTables", () => {
  it("lists the tables the user may read", async () => {
    const { ctx } = fake(["main.sales"]);
    expect(await listTables(ctx)).toEqual([{ name: "orders", full: "main.sales.orders", format: "parquet" }]);
  });

  it("lists every table when the grants are unchecked", async () => {
    const { ctx } = fake(null);
    expect(await listTables(ctx)).toHaveLength(2);
  });
});

describe("describeTable", () => {
  it("describes a readable table by its name or full name", async () => {
    const { ctx, calls } = fake(["main.sales.orders"]);
    const info = await describeTable(ctx, "  Orders ");
    expect(info).toEqual({ name: "orders", full: "main.sales.orders", columns: [{ name: "id", type: "int64" }], num_rows: 7 });
    expect(calls.at(-1)).toEqual({ method: "catalog.table", params: { name: "orders" } });
    expect((await describeTable(ctx, "main.sales.orders")).num_rows).toBe(7);
  });

  it("gives the same error for a table the user may not read and one that does not exist", async () => {
    const { ctx } = fake(["main.sales"]);
    await expect(describeTable(ctx, "secret")).rejects.toThrow("there is no table secret you can read");
    await expect(describeTable(ctx, "nope")).rejects.toThrow("there is no table nope you can read");
  });
});

describe("explainSql", () => {
  it("explains the wrapped query within the grants", async () => {
    const { ctx, calls } = fake(["main.sales"]);
    expect(await explainSql(ctx, "SELECT 1")).toEqual({ text: "plan" });
    expect(calls[0]).toEqual({ method: "sql.explain", params: { query: "SELECT * FROM (\nSELECT 1\n) AS _d", allow: ["main.sales"] } });
  });

  it("sends an empty grant as an empty list, and no grant when unchecked", async () => {
    const empty = fake([]);
    await explainSql(empty.ctx, "SELECT 1");
    expect(empty.calls[0].params.allow).toEqual([]);
    const unchecked = fake(null);
    await explainSql(unchecked.ctx, "SELECT 1");
    expect(unchecked.calls[0].params).not.toHaveProperty("allow");
  });
});

describe("runSql", () => {
  it("runs the query with one row more than asked, and returns the rows asked for", async () => {
    const { ctx, calls } = fake([]);
    const out = await runSql(ctx, "SELECT id FROM t", 1);
    expect(calls[0]).toEqual({
      method: "sql.run",
      params: { query: "SELECT * FROM (\nSELECT id FROM t\n) AS _d\nLIMIT 2", source: "assistant", allow: [] },
    });
    expect(calls[1]).toEqual({ method: "result.page", params: { result_id: "r1", offset: 0, limit: 1 } });
    expect(out).toEqual({ columns: [{ name: "id", type: "int64" }], rows: [[1], [2]], truncated: true });
  });

  it("clamps the rows to 1..MAX_ROWS", async () => {
    const { ctx, calls } = fake(null);
    await runSql(ctx, "SELECT 1", 10_000);
    expect(calls[0].params.query).toMatch(new RegExp(`LIMIT ${MAX_ROWS + 1}$`));
    await runSql(ctx, "SELECT 1", 0);
    expect(calls[2].params.query).toMatch(/LIMIT 2$/);
  });

  it("is not truncated when the query has no more rows", async () => {
    const { ctx } = fake(null, (m) => (m === "result.page" ? { offset: 0, total: 2, rows: [[1], [2]] } : defaults(m)));
    expect((await runSql(ctx, "SELECT 1")).truncated).toBe(false);
  });

  it("throws the engine's error", async () => {
    const { ctx } = fake(null, (m) => (m === "sql.run" ? { type: "error", ename: "Plan", evalue: "no read grant on table x", traceback: "" } : defaults(m)));
    await expect(runSql(ctx, "SELECT 1")).rejects.toThrow("Plan: no read grant on table x");
  });

  it("throws when the query returns no table", async () => {
    const { ctx } = fake(null, (m) => (m === "sql.run" ? { type: "text", text: "ok" } : defaults(m)));
    await expect(runSql(ctx, "SELECT 1")).rejects.toThrow("the query did not return a table");
  });

  it("interrupts a query that runs past the timeout", async () => {
    vi.useFakeTimers();
    const { ctx, calls } = fake(null, (m) => (m === "sql.run" ? new Promise(() => {}) : m === "interrupt" ? { interrupted: true } : defaults(m)));
    const pending = runSql(ctx, "SELECT 1");
    const failed = expect(pending).rejects.toThrow("the query took longer than 30 s");
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await failed;
    expect(calls.map((c) => c.method)).toEqual(["sql.run", "interrupt"]);
  });
});

describe("listFiles", () => {
  it("lists notebooks, SQL and text files in every folder, never data or other files", async () => {
    expect(await listFiles()).toEqual([
      { path: "a.py", kind: "notebook" },
      { path: "q/top.sql", kind: "sql" },
    ]);
  });
});

describe("readFile", () => {
  it("reads a listed file by its path", async () => {
    expect(await readFile("./q/top.sql")).toEqual({ path: "q/top.sql", text: "text of q/top.sql", truncated: false });
  });

  it("refuses a data file, an unlisted file and an escape alike", async () => {
    for (const p of ["data.parquet", ".iara/catalog.toml", "../secrets.env"]) await expect(readFile(p)).rejects.toThrow(`there is no notebook, SQL or text file ${p}`);
  });
});
