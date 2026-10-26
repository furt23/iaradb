import type { Cell, CellKind, CellOutput, CellState, NotebookView, Variable } from "@iara/protocol";
import { describe, expect, it, vi } from "vitest";

import { FileContext, type IaraChange } from "@/lib/iara/protocol";

import { cellStatus, clipHead, clipTail, notebookAdapter, notebookContext, runOutcome, summarizeCell, summarizeOutput, waitFor, type NotebookReview } from "./iaraBridge";
import { initialState, makeCell, notebookReducer, type NotebookState } from "./notebookState";

const cell = (id: string, code: string, extra: Partial<Cell> = {}): Cell => ({ id, kind: "python", code, name: "_", output: null, config: {}, setup: false, ...extra });
const done = (output: CellOutput | null, extra: Partial<CellState> = {}): CellState => ({ status: "done", stale: false, output, streams: [], elapsed_ms: 5, ...extra });
const table = (rows: number, columns = 2): CellOutput => ({
  type: "table",
  result: {
    id: "r",
    columns: Array.from({ length: columns }, (_, i) => ({ name: `c${i}`, type: "int64" })),
    num_rows: rows,
    page: { offset: 0, total: rows, rows: Array.from({ length: Math.min(rows, 50) }, (_, r) => Array.from({ length: columns }, (_, c) => r * 10 + c)) },
  },
});

function notebook(cells: Cell[], states: NotebookView["states"] = {}): NotebookState {
  return initialState({ path: "nb.py", cells, states });
}

describe("clipHead / clipTail", () => {
  it("keep the start or the end, within the limit", () => {
    expect(clipHead("abcdef", 4)).toBe("abc…");
    expect(clipTail("abcdef", 4)).toBe("…def");
    expect(clipHead("abc", 4)).toBe("abc");
    expect(clipTail("abc", 4)).toBe("abc");
  });
});

describe("summarizeOutput", () => {
  it("names images and html, and keeps the end of a text", () => {
    expect(summarizeOutput({ type: "image", mime: "image/png", data: "xx" }, 5, 100)).toBe("[image]");
    expect(summarizeOutput({ type: "html", html: "<b>x</b>" }, 5, 100)).toBe("[html]");
    expect(summarizeOutput({ type: "text", text: `${"a".repeat(50)}END` }, 5, 10)).toMatch(/^….*END$/);
  });

  it("says an error as name: message", () => {
    expect(summarizeOutput({ type: "error", ename: "ValueError", evalue: "bad", traceback: "line 1\nline 2" }, 5, 100)).toBe("ValueError: bad");
  });

  it("gives a table's size, columns and first rows as TSV", () => {
    expect(summarizeOutput(table(1000), 3, 1500)).toBe("1000 rows, columns: c0 (int64), c1 (int64)\nc0\tc1\n0\t1\n10\t11\n20\t21");
  });

  it("marks a preview whose total is unknown, and writes null and nested values on one line", () => {
    const out = table(2);
    if (out.type !== "table") throw new Error("table");
    out.result.truncated = true;
    out.result.page.rows = [[null, { a: [1, "x\ty"] }]];
    expect(summarizeOutput(out, 5, 1500)).toBe('2+ rows, columns: c0 (int64), c1 (int64)\nc0\tc1\nnull\t{"a":[1,"x\\ty"]}');
  });

  it("stays within the limit for a wide table", () => {
    expect(summarizeOutput(table(100, 400), 5, 1500).length).toBeLessThanOrEqual(1500);
  });
});

describe("summarizeCell", () => {
  it("is nothing for a cell that did not run", () => {
    expect(summarizeCell(undefined, 1500, 5)).toBeUndefined();
    expect(summarizeCell(done(null), 1500, 5)).toBeUndefined();
  });

  it("puts what the cell printed (its end) before its output, within the limit", () => {
    const s = done({ type: "text", text: "42" }, { streams: [{ stream: "stdout", text: "x".repeat(5000) }, { stream: "stderr", text: "warned\n" }] });
    const text = summarizeCell(s, 1500, 5)!;
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(text.startsWith("…")).toBe(true);
    expect(text.endsWith("warned\n42")).toBe(true);
  });
});

describe("cellStatus", () => {
  const state = notebook(
    [cell("a", "x = 1"), cell("b", "boom"), cell("c", "y = 2"), cell("d", "z = 3")],
    { a: done(null), b: { ...done(null), status: "error" }, c: done(null, { stale: true }) },
  );

  it("tells ok, error, stale and idle", () => {
    expect(state.cells.map((c) => cellStatus(state, c))).toEqual(["ok", "error", "stale", "idle"]);
  });

  it("calls a cell stale once it was edited after its run", () => {
    const edited = notebookReducer(state, { type: "edit", id: "a", patch: { code: "x = 2" } });
    expect(cellStatus(edited, edited.cells[0])).toBe("stale");
  });
});

describe("notebookContext", () => {
  const variables: Variable[] = [{ name: "df", type: "DataFrame", summary: "3 rows", cell_id: "a" }];

  it("lists every cell with status and output, the setup cell as 'setup'", () => {
    const state = notebook(
      [cell("s", "import polars as pl", { setup: true, name: "setup_block" }), cell("a", "df = 1", { name: "load" }), cell("m", "# Title", { kind: "markdown" })],
      { a: done(table(3)), m: done({ type: "markdown", text: "# Title" }) },
    );
    const ctx = notebookContext(state, variables, "a", true);
    expect(ctx.surface === "notebook" && ctx.cells.map((c) => [c.id, c.name, c.status])).toEqual([
      ["s", "setup", "idle"],
      ["a", "load", "ok"],
      ["m", undefined, "ok"],
    ]);
    if (ctx.surface !== "notebook") throw new Error("notebook");
    expect(ctx.cells[1].output).toContain("3 rows");
    expect(ctx.cells[2].output).toBeUndefined();
    expect(ctx.cells.map((c) => c.setup)).toEqual([true, undefined, undefined]);
    expect(ctx.selectedCellId).toBe("a");
    expect(ctx.variables).toEqual([{ name: "df", type: "DataFrame", summary: "3 rows" }]);
  });

  it("forgets a selected cell that is gone", () => {
    const ctx = notebookContext(notebook([cell("a", "")]), [], "gone", true);
    expect(ctx.surface === "notebook" && ctx.selectedCellId).toBeNull();
  });

  it("stays within the request's schema for a huge notebook", () => {
    const cells = Array.from({ length: 600 }, (_, i) => cell(`c${i}`, "x".repeat(30_000), { name: "n".repeat(300) }));
    const states = Object.fromEntries(cells.map((c) => [c.id, done(table(5000, 300), { streams: [{ stream: "stdout" as const, text: "y".repeat(9000) }] })]));
    const many: Variable[] = Array.from({ length: 700 }, (_, i) => ({ name: "v".repeat(300) + i, type: "t".repeat(300), summary: "s".repeat(900), cell_id: null }));
    const ctx = notebookContext(notebook(cells, states), many, "c1", true);
    expect(() => FileContext.parse(ctx)).not.toThrow();
    if (ctx.surface !== "notebook") throw new Error("notebook");
    expect(ctx.cells).toHaveLength(500);
    expect(Math.max(...ctx.cells.map((c) => c.output!.length))).toBeLessThanOrEqual(1500);
  });
});

describe("runOutcome", () => {
  it("reports an ok run with the output", () => {
    const state = notebook([cell("a", "")], { a: done({ type: "text", text: "hi" }) });
    expect(runOutcome(state, "a")).toEqual({ applied: true, cellId: "a", ran: true, status: "ok", output: "hi" });
  });

  it("reports an error with what was printed and the end of the traceback, without colors", () => {
    const output: CellOutput = { type: "error", ename: "KeyError", evalue: "'x'", traceback: `\u001b[31mTraceback\u001b[0m\n${"line\n".repeat(2000)}KeyError: 'x'` };
    const state = notebook([cell("a", "")], { a: { ...done(output), status: "error", streams: [{ stream: "stdout", text: "step 1" }] } });
    const out = runOutcome(state, "a");
    expect(out).toMatchObject({ ran: true, status: "error", output: "step 1" });
    expect(out.error!.length).toBeLessThanOrEqual(4000);
    expect(out.error!.startsWith("KeyError: 'x'\n")).toBe(true);
    expect(out.error!.endsWith("KeyError: 'x'")).toBe(true);
    expect(out.error).not.toContain("\u001b");
  });

  it("says when the run was stopped or never reached the cell", () => {
    const state = notebook([cell("a", ""), cell("b", "")], { a: { ...done(null), status: "cancelled" } });
    expect(runOutcome(state, "a")).toMatchObject({ status: "error", error: "The run was stopped." });
    expect(runOutcome(state, "b")).toMatchObject({ status: "error", error: "The cell did not finish." });
  });

  it("keeps a big table within the outcome limit", () => {
    const state = notebook([cell("a", "")], { a: done(table(5000, 300)) });
    expect(runOutcome(state, "a").output!.length).toBeLessThanOrEqual(8000);
  });
});

/** A notebook as the adapter reads it (its state, its commands, the review shown) and the setter it shows a review with. */
function fakeNotebook(cells: Cell[], canRun = false) {
  let state = notebook(cells);
  let review: NotebookReview | null = null;
  const run = vi.fn(async () => {});
  const nb = {
    get state() {
      return state;
    },
    addCell: (index: number, kind: CellKind) => {
      const added = makeCell(kind, state.cells);
      state = notebookReducer(state, { type: "add", index, cell: added });
      return added;
    },
    edit: (id: string, patch: { code: string }) => {
      state = notebookReducer(state, { type: "edit", id, patch });
    },
    run,
  };
  const live = {
    current: {
      nb,
      variables: [],
      get review() {
        return review;
      },
      show: () => {},
    },
  } as unknown as Parameters<typeof notebookAdapter>[0];
  const setReview: Parameters<typeof notebookAdapter>[2] = (next) => {
    review = typeof next === "function" ? next(review) : next;
  };
  return {
    adapter: notebookAdapter(live, canRun, setReview),
    run,
    codes: () => state.cells.map((c) => c.code),
    review: () => review,
  };
}

const decide = { keep: vi.fn(), undo: vi.fn() };
const editA: Extract<IaraChange, { action: "edit_cell" }> = { action: "edit_cell", cellId: "a", edits: [{ old: "x = 1", new: "x = 2" }], run: false };

describe("notebookAdapter without a running cluster", () => {
  it("applies an insert without running it, and refuses to run a cell", async () => {
    const { adapter, run, codes } = fakeNotebook([cell("a", "x = 1")]);

    expect(adapter.canRun).toBe(false);
    expect(await adapter.apply({ action: "insert_cell", kind: "python", code: "y = 2", afterCellId: "a", run: true }, true)).toMatchObject({ applied: true, ran: false });
    expect(codes()).toEqual(["x = 1", "y = 2"]);
    expect(await adapter.apply({ action: "run_cell", cellId: "a" }, true)).toEqual({ applied: false, ran: false, error: "the cluster is not running" });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not take a query edit", async () => {
    const { adapter } = fakeNotebook([cell("a", "x = 1")]);
    await expect(adapter.apply({ action: "edit_query", edits: [{ old: "", new: "select 1" }], run: false }, false)).rejects.toThrow("not possible in a notebook");
  });
});

describe("notebookAdapter preview", () => {
  it("shows an edit as the edited code against the cell's, and takes it away", () => {
    const { adapter, review } = fakeNotebook([cell("a", "x = 1")]);
    const clear = adapter.preview!(editA, decide);
    expect(review()).toMatchObject({ change: editA, cellId: "a", kind: "python", original: "x = 1", code: "x = 2", decide });
    clear();
    expect(review()).toBeNull();
  });

  it("shows a new cell with all its code as new", () => {
    const { adapter, review } = fakeNotebook([cell("a", "x = 1")]);
    adapter.preview!({ action: "insert_cell", kind: "sql", code: "select 1", afterCellId: null, run: false }, decide);
    expect(review()).toMatchObject({ cellId: null, kind: "sql", original: "", code: "select 1" });
  });

  it("shows nothing for edits that do not fit, a missing cell, or a change without code", () => {
    const { adapter, review } = fakeNotebook([cell("a", "x = 1")]);
    adapter.preview!({ ...editA, edits: [{ old: "nope", new: "y" }] }, decide);
    adapter.preview!({ ...editA, cellId: "gone" }, decide);
    adapter.preview!({ action: "insert_cell", kind: "python", code: "y", afterCellId: "gone", run: false }, decide);
    adapter.preview!({ action: "run_cell", cellId: "a" }, decide);
    expect(review()).toBeNull();
  });

  it("does not take away the review of another change", () => {
    const { adapter, review } = fakeNotebook([cell("a", "x = 1")]);
    const clear = adapter.preview!(editA, decide);
    adapter.preview!({ ...editA }, decide);
    clear();
    expect(review()).not.toBeNull();
  });
});

describe("notebookAdapter apply of a reviewed change", () => {
  it("writes the code as the user adjusted it, and takes the review away", async () => {
    const { adapter, review, codes } = fakeNotebook([cell("a", "x = 1")]);
    adapter.preview!(editA, decide);
    review()!.setCode("x = 3");
    expect(await adapter.apply(editA, false)).toMatchObject({ applied: true, cellId: "a", ran: false });
    expect(codes()).toEqual(["x = 3"]);
    expect(review()).toBeNull();
  });

  it("writes the edited code when there is no review", async () => {
    const { adapter, codes } = fakeNotebook([cell("a", "x = 1")]);
    await adapter.apply(editA, false);
    expect(codes()).toEqual(["x = 2"]);
  });

  it("fails an edit that does not fit the cell, changing nothing", async () => {
    const { adapter, codes } = fakeNotebook([cell("a", "x = 5")]);
    await expect(adapter.apply(editA, false)).rejects.toThrow(/not found/);
    expect(codes()).toEqual(["x = 5"]);
  });

  it("never shows or applies an edit of the setup cell", async () => {
    const { adapter, review, codes } = fakeNotebook([cell("a", "x = 1", { setup: true })]);
    adapter.preview!(editA, decide);
    expect(review()).toBeNull();
    await expect(adapter.apply(editA, false)).rejects.toThrow(/setup/);
    expect(codes()).toEqual(["x = 1"]);
  });
});

describe("waitFor", () => {
  it("resolves true once the condition holds", async () => {
    let ok = false;
    setTimeout(() => (ok = true), 30);
    expect(await waitFor(() => ok, 1000)).toBe(true);
  });

  it("gives up after the time", async () => {
    expect(await waitFor(() => false, 50)).toBe(false);
  });
});
