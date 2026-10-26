import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";

import type { IaraChange, IaraFileContext } from "@/lib/iara/protocol";

import type { ToolContext } from "../../ai/tools";
import { MAX_REVIEWS, type IaraDeps, type IaraGraphState } from "../state";
import { checkChange, reviewerNode } from "./reviewer";
import { FAST_MODEL } from "../../ai/models";

vi.mock("../tokens", () => ({
  countTokens: async (text: string) => Math.ceil(text.length / 4),
  countSteps: async () => 0,
  cutToTokens: async (text: string) => text,
}));

const NOTEBOOK: IaraFileContext = {
  surface: "notebook",
  path: "n.ipynb",
  cells: [
    { id: "c1", kind: "python", code: "x = 1" },
    { id: "c2", kind: "sql", code: "SELECT 1" },
  ],
  variables: [],
};
const SQL: IaraFileContext = { surface: "sql", path: "q.sql", query: "SELECT 1" };

const insert = (over: Partial<Extract<IaraChange, { action: "insert_cell" }>> = {}): IaraChange => ({ action: "insert_cell", kind: "python", code: "y = 2", afterCellId: "c1", run: false, ...over });

describe("checkChange", () => {
  it("accepts changes that fit the file", () => {
    expect(checkChange(insert(), NOTEBOOK)).toEqual([]);
    expect(checkChange(insert({ afterCellId: null, kind: "markdown", code: "# Title" }), NOTEBOOK)).toEqual([]);
    expect(checkChange({ action: "edit_cell", cellId: "c2", edits: [{ old: "SELECT 1", new: "SELECT 2" }], run: true }, NOTEBOOK)).toEqual([]);
    expect(checkChange({ action: "run_cell", cellId: "c1" }, NOTEBOOK)).toEqual([]);
    expect(checkChange({ action: "edit_query", edits: [{ old: "SELECT 1", new: "SELECT 2" }], run: false }, SQL)).toEqual([]);
  });

  it("refuses cells in the SQL editor and edit_query in a notebook", () => {
    expect(checkChange(insert(), SQL)).toEqual(["insert_cell only works in a notebook"]);
    expect(checkChange({ action: "edit_cell", cellId: "c1", edits: [{ old: "x = 1", new: "x" }], run: false }, SQL)).toHaveLength(1);
    expect(checkChange({ action: "run_cell", cellId: "c1" }, SQL)).toHaveLength(1);
    expect(checkChange({ action: "edit_query", edits: [{ old: "SELECT 1", new: "SELECT 2" }], run: false }, NOTEBOOK)).toEqual(["edit_query only works in the SQL editor"]);
  });

  it("refuses a cell that is not in the notebook", () => {
    expect(checkChange(insert({ afterCellId: "zz" }), NOTEBOOK)).toEqual(["there is no cell zz to insert after"]);
    expect(checkChange({ action: "edit_cell", cellId: "zz", edits: [{ old: "x = 1", new: "x" }], run: false }, NOTEBOOK)).toEqual(["there is no cell zz"]);
    expect(checkChange({ action: "run_cell", cellId: "zz" }, NOTEBOOK)).toEqual(["there is no cell zz"]);
  });

  it("refuses an edit of the setup cell, though it may still run", () => {
    const ctx: IaraFileContext = { ...NOTEBOOK, cells: [{ id: "s", kind: "python", code: "import iara", setup: true }, ...NOTEBOOK.cells] };
    expect(checkChange({ action: "edit_cell", cellId: "s", edits: [{ old: "import iara", new: "import os" }], run: false }, ctx)).toEqual([
      "cell s is the notebook's setup, which you must not edit; change another cell or add one",
    ]);
    expect(checkChange({ action: "run_cell", cellId: "s" }, ctx)).toEqual([]);
  });

  it("refuses blank code, markdown included", () => {
    expect(checkChange(insert({ code: "  \n" }), NOTEBOOK)).toEqual(["the code is empty"]);
    expect(checkChange(insert({ kind: "markdown", code: "" }), NOTEBOOK)).toEqual(["the code is empty"]);
    expect(checkChange({ action: "edit_cell", cellId: "c1", edits: [{ old: "x = 1", new: " " }], run: false }, NOTEBOOK)).toEqual(["the code is empty"]);
    expect(checkChange({ action: "edit_query", edits: [{ old: "SELECT 1", new: " " }], run: false }, SQL)).toEqual(["the code is empty"]);
  });

  it("reports edits that do not fit the code, and edits that empty it", () => {
    expect(checkChange({ action: "edit_cell", cellId: "c1", edits: [{ old: "y = 9", new: "y = 8" }], run: false }, NOTEBOOK)).toEqual([
      "old was not found in the code; copy it exactly from the current code",
    ]);
    expect(checkChange({ action: "edit_query", edits: [{ old: "SELECT 1", new: "" }], run: false }, SQL)).toEqual(["the code is empty"]);
  });

  it("reports the missing cell and the blank code together", () => {
    expect(checkChange(insert({ afterCellId: "zz", code: "" }), NOTEBOOK)).toHaveLength(2);
  });
});

// ---- the node ----

const state = (over: Partial<IaraGraphState> = {}): IaraGraphState =>
  ({
    context: NOTEBOOK,
    handoff: { callId: "h1", name: "propose_change", request: "add a column y" },
    draft: { change: insert(), explanation: "Adds y." },
    findings: [],
    refusal: null,
    reviewNotes: null,
    reviews: 0,
    fixes: 0,
    proposal: null,
    steps: 4,
    ...over,
  }) as IaraGraphState;

/** Deps with a kernel whose explain fails with `explainError`, a model review and a Python lint. */
function deps(opts: { explainError?: string; review?: unknown; lint?: { severity: string; message: string }[] | null } = {}) {
  const explained: unknown[] = [];
  const request = async (method: string, params: unknown) => {
    if (method === "sql.explain") {
      explained.push(params);
      if (opts.explainError) throw new Error(opts.explainError);
      return { text: "plan" };
    }
    return {};
  };
  const llm = vi.fn(async () => opts.review ?? { ok: true, notes: "" });
  const lint = opts.lint === null ? null : vi.fn(async () => opts.lint ?? []);
  const d: IaraDeps = { chat: vi.fn(), llm, tools: { request, allow: ["main"] } as unknown as ToolContext, user: {} as IaraDeps["user"], lint };
  return { d, llm, lint, explained };
}

const run = (d: IaraDeps, s: IaraGraphState) => {
  const writer = vi.fn();
  return reviewerNode(d)(s, { writer } as unknown as LangGraphRunnableConfig).then((out) => ({ out, writer }));
};

const sqlDraft = (sql: string) => ({ change: { action: "edit_query", edits: [{ old: "SELECT 1", new: sql }], run: false } as IaraChange, explanation: "Sets the query." });

describe("reviewerNode", () => {
  it("passes a good change with the model's go-ahead", async () => {
    const { d, llm, lint } = deps();
    const { out, writer } = await run(d, state({ fixes: 1 }));
    expect(writer).toHaveBeenCalledWith({ type: "agent", agent: "reviewer" });
    expect(out).toMatchObject({
      refusal: null,
      reviewNotes: null,
      steps: 5,
      proposal: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), change: insert(), explanation: "Adds y.", review: null, attempt: 2 },
    });
    expect(lint).toHaveBeenCalledWith("y = 2", "python");
    // the model sees the task, the change and the file
    const [model, , prompt] = llm.mock.calls[0] as unknown as [string, string, string];
    expect(model).toBe(FAST_MODEL);
    expect(prompt).toContain("add a column y");
    expect(prompt).toContain('"action":"insert_cell"');
    expect(prompt).toContain("Adds y.");
    expect(prompt).toContain("cell c1");
  });

  it("shows the model the code an edit leaves", async () => {
    const { d, llm } = deps();
    await run(d, state({ draft: { change: { action: "edit_cell", cellId: "c1", edits: [{ old: "x = 1", new: "x = 2" }], run: false }, explanation: "x" } }));
    const [, , prompt] = llm.mock.calls[0] as unknown as [string, string, string];
    expect(prompt).toContain("The code after the change:\nx = 2");
  });

  it("refuses a change that does not fit the file, without asking the model", async () => {
    const { d, llm } = deps();
    const { out } = await run(d, state({ draft: { change: insert({ afterCellId: "zz" }), explanation: "x" } }));
    expect(out).toEqual({ refusal: "there is no cell zz to insert after", reviews: 1, proposal: null, steps: 4 });
    expect(llm).not.toHaveBeenCalled();
  });

  it("refuses SQL that does not plan", async () => {
    const { d, llm, explained } = deps({ explainError: "no table x" });
    const { out } = await run(d, state({ context: SQL, draft: sqlDraft("SELECT * FROM x") }));
    expect(out).toEqual({ refusal: "The SQL does not plan: no table x", reviews: 1, proposal: null, steps: 4 });
    expect(explained[0]).toEqual({ query: "SELECT * FROM (\nSELECT * FROM x\n) AS _d", allow: ["main"] });
    expect(llm).not.toHaveBeenCalled();
  });

  it("plans the SQL of a SQL cell, edited or inserted, and not that of a Python one", async () => {
    const edit = deps();
    await run(edit.d, state({ draft: { change: { action: "edit_cell", cellId: "c2", edits: [{ old: "SELECT 1", new: "SELECT 2" }], run: false }, explanation: "x" } }));
    expect(edit.explained).toHaveLength(1);
    expect(edit.lint).not.toHaveBeenCalled();

    const sql = deps();
    await run(sql.d, state({ draft: { change: insert({ kind: "sql", code: "SELECT 3" }), explanation: "x" } }));
    expect(sql.explained).toHaveLength(1);

    const python = deps();
    await run(python.d, state({ draft: { change: { action: "edit_cell", cellId: "c1", edits: [{ old: "x = 1", new: "x = 2" }], run: false }, explanation: "x" } }));
    expect(python.explained).toHaveLength(0);
    expect(python.lint).toHaveBeenCalledWith("x = 2", "python");
  });

  it("leaves statements that write to the model review instead of planning them", async () => {
    const { d, llm, explained } = deps({ explainError: "not a query", review: { ok: true, notes: "Overwrites main.sales.totals." } });
    const { out } = await run(d, state({ context: SQL, draft: sqlDraft("CREATE OR REPLACE TABLE main.sales.totals AS SELECT 1") }));
    expect(explained).toHaveLength(0);
    expect(llm).toHaveBeenCalledOnce();
    expect(out.proposal).toMatchObject({ review: "Overwrites main.sales.totals." });
  });

  it("refuses when the model says the change is wrong, with its notes", async () => {
    const { d } = deps({ review: { ok: false, notes: "It drops the filter on y." } });
    const { out } = await run(d, state());
    expect(out).toEqual({ refusal: "It drops the filter on y.", reviews: 1, proposal: null, steps: 5 });
  });

  it("refuses a Python error and keeps the warnings as notes", async () => {
    const bad = deps({ lint: [{ severity: "error", message: "line 1: invalid syntax" }, { severity: "warning", message: "unused import" }] });
    const { out } = await run(bad.d, state());
    expect(out).toEqual({ refusal: "line 1: invalid syntax", reviews: 1, proposal: null, steps: 4 });
    expect(bad.llm).not.toHaveBeenCalled();

    const warned = deps({ lint: [{ severity: "warning", message: "unused import" }], review: { ok: true, notes: "Runs for a while." } });
    const ok = await run(warned.d, state());
    expect(ok.out).toMatchObject({ refusal: null, reviewNotes: "unused import\nRuns for a while.", proposal: { review: "unused import\nRuns for a while." } });
  });

  it("skips the lint when there is no notebook", async () => {
    const { d } = deps({ lint: null });
    const { out } = await run(d, state());
    expect(out.proposal).toBeTruthy();
  });

  it("sends the draft to the user with the reviewer's notes after MAX_REVIEWS refusals", async () => {
    const planning = deps({ explainError: "no table x" });
    const { out } = await run(planning.d, state({ context: SQL, draft: sqlDraft("SELECT * FROM x"), reviews: MAX_REVIEWS }));
    expect(out).toMatchObject({ refusal: null, reviewNotes: null, steps: 4, proposal: { review: "The SQL does not plan: no table x", attempt: 1 } });
    expect(out).not.toHaveProperty("reviews");

    const model = deps({ review: { ok: false, notes: "Does not filter by year." } });
    const second = await run(model.d, state({ reviews: MAX_REVIEWS }));
    expect(second.out).toMatchObject({ refusal: null, reviewNotes: "Does not filter by year.", proposal: { review: "Does not filter by year." } });
  });

  it("goes on when the model's review is not in the shape asked for", async () => {
    const { d } = deps({ review: { verdict: "fine" } });
    const { out } = await run(d, state());
    expect(out).toMatchObject({ refusal: null, steps: 5, proposal: { review: null } });
  });
});
