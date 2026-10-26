import type { CellOutput } from "@iara/protocol";
import { describe, expect, it } from "vitest";

import type { SqlView } from "@/features/sql/useSqlRunner";
import { FileContext, Outcome } from "@/lib/iara/protocol";

import { resultSummary, sqlContext, sqlOutcome } from "./sqlIaraBridge";

const table = (rows: number, columns = 2): CellOutput => ({
  type: "table",
  result: {
    id: "r",
    columns: Array.from({ length: columns }, (_, i) => ({ name: `c${i}`, type: "int64" })),
    num_rows: rows,
    page: { offset: 0, total: rows, rows: Array.from({ length: Math.min(rows, 50) }, (_, r) => Array.from({ length: columns }, (_, c) => r * 10 + c)) },
  },
});
const output = (o: CellOutput): SqlView => ({ kind: "output", output: o });

describe("resultSummary", () => {
  it("is nothing before a run", () => {
    expect(resultSummary(null)).toBeUndefined();
  });

  it("gives the size, columns and first 10 rows of a table", () => {
    const lines = resultSummary(output(table(500)))!.split("\n");
    expect(lines[0]).toBe("500 rows, columns: c0 (int64), c1 (int64)");
    expect(lines).toHaveLength(2 + 10);
    expect(lines[2]).toBe("0\t1");
  });

  it("says an error, a plan and a text", () => {
    expect(resultSummary({ kind: "error", message: "no such table: t" })).toBe("Error: no such table: t");
    expect(resultSummary({ kind: "explain", plan: {} as never, text: "Scan t" })).toBe("Plan:\nScan t");
    expect(resultSummary(output({ type: "text", text: "OK" }))).toBe("OK");
  });

  it("stays within the limit", () => {
    expect(resultSummary(output(table(5000, 1000)))!.length).toBeLessThanOrEqual(8000);
    expect(resultSummary({ kind: "error", message: "x".repeat(20_000) })!.length).toBeLessThanOrEqual(8000);
  });
});

describe("sqlContext", () => {
  it("is the path, the query and the last result", () => {
    expect(sqlContext("q/a.sql", "select 1", output({ type: "text", text: "1" }))).toEqual({ surface: "sql", path: "q/a.sql", query: "select 1", result: "1" });
  });

  it("leaves the result out before a run", () => {
    expect(sqlContext("q/a.sql", "select 1", null)).toEqual({ surface: "sql", path: "q/a.sql", query: "select 1" });
  });

  it("stays within the request's schema", () => {
    const ctx = sqlContext("p".repeat(2000), "select ".repeat(10_000), output(table(5000, 1000)));
    expect(() => FileContext.parse(ctx)).not.toThrow();
  });
});

describe("sqlOutcome", () => {
  it("is ok with the result's summary", () => {
    const view = output(table(3));
    expect(sqlOutcome(view, null)).toEqual({ applied: true, ran: true, status: "ok", output: resultSummary(view) });
  });

  it("is an error with the message", () => {
    expect(sqlOutcome({ kind: "error", message: "boom" }, null)).toEqual({ applied: true, ran: true, status: "error", error: "boom" });
    expect(sqlOutcome(output({ type: "error", ename: "Oops", evalue: "bad", traceback: "" }), null)).toMatchObject({ status: "error", error: "Oops: bad" });
  });

  it("is an error when the run left the old view (it was stopped)", () => {
    const old = output(table(3));
    expect(sqlOutcome(old, old)).toMatchObject({ status: "error", error: "The query did not finish." });
    expect(sqlOutcome(null, null)).toMatchObject({ status: "error" });
  });

  it("stays within the outcome's schema", () => {
    expect(() => Outcome.parse(sqlOutcome(output(table(5000, 1000)), null))).not.toThrow();
    expect(() => Outcome.parse(sqlOutcome({ kind: "error", message: "x".repeat(20_000) }, null))).not.toThrow();
  });
});
