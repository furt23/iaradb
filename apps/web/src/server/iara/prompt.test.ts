import { describe, expect, it, vi } from "vitest";

import type { IaraFileContext } from "@/lib/iara/protocol";

import { contextText, resultStep, userStep } from "./prompt";

// chars / 4
vi.mock("./tokens", () => ({
  countTokens: async (text: string) => Math.ceil(text.length / 4),
  countSteps: async () => 0,
  cutToTokens: async (text: string, max: number) => (text.length / 4 > max ? `${text.slice(0, max * 4)}\n… (cut)` : text),
}));

describe("contextText", () => {
  it("lists a notebook's cells in order with the selected one and the variables", async () => {
    const ctx: IaraFileContext = {
      surface: "notebook",
      path: "sales.ipynb",
      cells: [
        { id: "a1", kind: "python", name: "load", code: "df = load()", output: "3 rows", status: "ok" },
        { id: "b2", kind: "sql", code: "SELECT 1", status: "error" },
      ],
      selectedCellId: "b2",
      variables: [{ name: "df", type: "DataFrame", summary: "3 x 2" }, { name: "n", type: "int" }],
    };
    const text = await contextText(ctx);
    expect(text).toContain("Notebook sales.ipynb");
    expect(text.indexOf("[cell a1")).toBeLessThan(text.indexOf("[cell b2"));
    expect(text).toContain('[cell a1, python, "load", status ok]\ndf = load()\noutput: 3 rows');
    expect(text).toContain("[cell b2, sql, status error, selected]\nSELECT 1");
    expect(text).toContain("variables:\ndf: DataFrame = 3 x 2\nn: int");
  });

  it("gives the SQL editor's query and last result", async () => {
    const text = await contextText({ surface: "sql", path: "q.sql", query: "SELECT 1", result: "n\n1" });
    expect(text).toBe("SQL editor q.sql\n\nquery:\nSELECT 1\n\nlast result:\nn\n1");
    expect(await contextText({ surface: "sql", path: "q.sql", query: "" })).toContain("(empty)");
  });

  it("cuts a big file to the token budget", async () => {
    const text = await contextText({ surface: "sql", path: "q.sql", query: "x".repeat(10_000) }, 100);
    expect(text.length).toBeLessThan(500);
    expect(text).toMatch(/… \(cut\)$/);
  });
});

describe("steps", () => {
  it("builds a user step and a function result", () => {
    expect(userStep("hi")).toEqual({ type: "user_input", content: [{ type: "text", text: "hi" }] });
    expect(resultStep({ id: "c1", name: "run_sql" }, "ok")).toEqual({ type: "function_result", call_id: "c1", name: "run_sql", result: "ok" });
    expect(resultStep({ id: "c1", name: "run_sql" }, "boom", true)).toMatchObject({ is_error: true });
  });
});
