import { describe, expect, it } from "vitest";

import type { IaraProposalRecord } from "@/lib/iara/protocol";

import { changeDiff, changeLanguage, changeTitle, knowledgeOf, recordStatus, thoughtParts, toolLabel } from "./labels";

const record = (over: Partial<IaraProposalRecord>): IaraProposalRecord => ({
  id: "p",
  change: { action: "insert_cell", kind: "python", code: "x = 1", afterCellId: null, run: true },
  explanation: "",
  review: null,
  attempt: 1,
  decision: "approved",
  ...over,
});

describe("toolLabel", () => {
  it("names the table it reads, or a table when it has none", () => {
    expect(toolLabel({ agent: "analyst", tool: "describe_table", target: "sales" })).toEqual({ key: "Reading {{target}}", values: { target: "sales" } });
    expect(toolLabel({ agent: "analyst", tool: "describe_table" }).key).toBe("Reading a table");
    expect(toolLabel({ agent: "analyst", tool: "something_new" }).key).toBe("Looking at the data");
  });
});

describe("the ontology", () => {
  it("says what was looked up", () => {
    expect(toolLabel({ agent: "analyst", tool: "search_ontology", target: "churn" })).toEqual({ key: "Looking up “{{target}}” in the ontology", values: { target: "churn" } });
    expect(toolLabel({ agent: "analyst", tool: "search_ontology" }).key).toBe("Reading the ontology");
  });

  it("collects the terms the steps read, each once, by team, certified first", () => {
    const k = (team: string, term: string, certified = true) => ({ team, term, certified, description: "d" });
    const steps = [
      { kind: "tool" as const, agent: "analyst" as const, tool: "search_ontology", knowledge: [k("Ops", "SLA"), k("Finance", "Net revenue")] },
      { kind: "thought" as const, agent: "analyst" as const, id: "t", text: "hm" },
      { kind: "tool" as const, agent: "analyst" as const, tool: "run_sql" },
      { kind: "tool" as const, agent: "analyst" as const, tool: "search_ontology", knowledge: [k("Finance", "Net revenue"), k("Finance", "Churn", false)] },
    ];
    expect(knowledgeOf(steps)).toEqual([k("Finance", "Net revenue"), k("Finance", "Churn", false), k("Ops", "SLA")]);
    expect(knowledgeOf(undefined)).toEqual([]);
    expect(knowledgeOf([steps[2]])).toEqual([]);
  });
});

describe("thoughtParts", () => {
  it("takes a leading bold line as the title and the rest as the body", () => {
    expect(thoughtParts("**Exploring the tables**\n\nThe sales table looks right.\n")).toEqual({
      title: "Exploring the tables",
      body: "The sales table looks right.",
    });
  });

  it("has no title without a leading bold line, or while the line is still streaming", () => {
    expect(thoughtParts("  Checking the query  ")).toEqual({ title: null, body: "Checking the query" });
    expect(thoughtParts("**Explor")).toEqual({ title: null, body: "**Explor" });
    expect(thoughtParts("**A** and **B**")).toEqual({ title: null, body: "**A** and **B**" });
  });
});

describe("changes", () => {
  it("titles and language", () => {
    const insert = record({}).change;
    expect(changeTitle(insert)).toEqual({ key: "New {{kind}} cell", values: { kind: "python" } });
    expect(changeLanguage({ action: "edit_query", edits: [{ old: "", new: "select 1" }], run: false })).toBe("sql");
  });

  it("an edit takes the language of its cell", () => {
    const context = { surface: "notebook" as const, path: "n", variables: [], cells: [{ id: "c1", kind: "sql" as const, code: "select 1" }] };
    const edits = [{ old: "select 1", new: "select 2" }];
    expect(changeLanguage({ action: "edit_cell", cellId: "c1", edits, run: false }, context)).toBe("sql");
    expect(changeLanguage({ action: "edit_cell", cellId: "gone", edits, run: false }, context)).toBe("python");
  });
});

describe("changeDiff", () => {
  const notebook = { surface: "notebook" as const, path: "n", variables: [], cells: [{ id: "c1", kind: "python" as const, code: "x = 1" }] };
  const sql = { surface: "sql" as const, path: "q.sql", query: "select 1" };

  it("is the code a change starts from and the code it writes; null for a run", () => {
    expect(changeDiff({ action: "insert_cell", kind: "python", code: "y = 2", afterCellId: "c1", run: false }, notebook)).toEqual({ before: null, after: "y = 2" });
    expect(changeDiff({ action: "edit_cell", cellId: "c1", edits: [{ old: "x = 1", new: "x = 2" }], run: false }, notebook)).toEqual({ before: "x = 1", after: "x = 2" });
    expect(changeDiff({ action: "edit_query", edits: [{ old: "select 1", new: "select 2" }], run: false }, sql)).toEqual({ before: "select 1", after: "select 2" });
    expect(changeDiff({ action: "run_cell", cellId: "c1" }, notebook)).toBeNull();
  });

  it("throws when the cell is gone, the surface is wrong, or the edits do not fit the code", () => {
    expect(() => changeDiff({ action: "edit_cell", cellId: "gone", edits: [{ old: "x = 1", new: "x" }], run: false }, notebook)).toThrow("There is no cell");
    expect(() => changeDiff({ action: "edit_query", edits: [{ old: "select 1", new: "x" }], run: false }, notebook)).toThrow("not possible in a notebook");
    expect(() => changeDiff({ action: "edit_cell", cellId: "c1", edits: [{ old: "y = 9", new: "y" }], run: false }, notebook)).toThrow("old was not found");
  });
});

describe("recordStatus", () => {
  it("a rejected proposal", () => {
    expect(recordStatus(record({ decision: "rejected" }))).toEqual({ label: { key: "Rejected" }, tone: "muted" });
  });

  it("applied, with and without a run", () => {
    expect(recordStatus(record({ outcome: { applied: true, ran: false } })).label.key).toBe("Applied");
    expect(recordStatus(record({ outcome: { applied: true, ran: true, status: "ok" } })).label.key).toBe("Applied and ran");
    expect(recordStatus(record({ outcome: { applied: true, ran: true, status: "error" } }))).toEqual({ label: { key: "Applied, ran with an error" }, tone: "error" });
  });

  it("a change that was not applied", () => {
    expect(recordStatus(record({ outcome: { applied: false, ran: false, error: "boom" } }))).toEqual({ label: { key: "Not applied" }, tone: "error" });
  });

  it("a run of a cell", () => {
    const run = { change: { action: "run_cell" as const, cellId: "c" } };
    expect(recordStatus(record({ ...run, outcome: { applied: true, ran: true, status: "ok" } })).label.key).toBe("Ran");
    expect(recordStatus(record({ ...run, outcome: { applied: true, ran: true, status: "error" } })).label.key).toBe("Ran with an error");
    expect(recordStatus(record({ ...run, outcome: { applied: false, ran: false } })).label.key).toBe("Not run");
  });
});
