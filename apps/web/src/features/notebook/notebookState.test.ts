import type { Cell, CellStatus, NotebookView } from "@workhouse/protocol";
import { describe, expect, it } from "vitest";

import { fullIndex, initialState, isStale, makeCell, newCellId, nextResultName, notebookReducer, setupCell, setupError, totalElapsed, visibleCells, type NotebookAction, type NotebookState } from "./notebookState";

const st = (cell_id: string, status: CellStatus, elapsed_ms: number | null = null): NotebookAction => ({
  type: "cell.state",
  data: { cell_id, status, stale: false, output: null, streams: [], elapsed_ms },
});

const cell = (id: string, code: string, kind: Cell["kind"] = "python"): Cell => ({ id, kind, code, name: "_", output: null, config: {}, setup: false });

function state(): NotebookState {
  const view: NotebookView = {
    path: "nb.py",
    cells: [cell("a", "x = 1"), cell("b", "y = x")],
    states: {
      a: { status: "done", stale: false, output: null, streams: [], elapsed_ms: 1 },
      b: { status: "done", stale: true, output: null, streams: [], elapsed_ms: 1 },
    },
  };
  return initialState(view);
}

describe("notebook state", () => {
  it("knows stale cells from the kernel and from edits", () => {
    let s = state();
    expect(isStale(s, s.cells[0])).toBe(false);
    expect(isStale(s, s.cells[1])).toBe(true);
    s = notebookReducer(s, { type: "edit", id: "a", patch: { code: "x = 2" } });
    expect(s.dirty).toBe(true);
    expect(isStale(s, s.cells[0])).toBe(true);
  });

  it("records the code that ran when the kernel reports completion", () => {
    let s = notebookReducer(state(), { type: "edit", id: "a", patch: { code: "x = 3" } });
    s = notebookReducer(s, { type: "run", cells: s.cells, at: 0 });
    s = notebookReducer(s, { type: "edit", id: "a", patch: { code: "x = 4" } }); // edited while running
    s = notebookReducer(s, { type: "cell.state", data: { cell_id: "a", status: "done", stale: false, output: null, streams: [], elapsed_ms: 2 } });
    expect(s.runCode.a).toBe("x = 3");
    expect(isStale(s, s.cells[0])).toBe(true);
  });

  it("accumulates streams per stream name", () => {
    let s = state();
    s = notebookReducer(s, { type: "cell.stream", data: { cell_id: "a", stream: "stdout", text: "he" } });
    s = notebookReducer(s, { type: "cell.stream", data: { cell_id: "a", stream: "stdout", text: "llo\n" } });
    s = notebookReducer(s, { type: "cell.stream", data: { cell_id: "a", stream: "stderr", text: "warn" } });
    expect(s.states.a.streams).toEqual([
      { stream: "stdout", text: "hello\n" },
      { stream: "stderr", text: "warn" },
    ]);
  });

  it("adds, moves and removes cells", () => {
    let s = state();
    const c = makeCell("sql", s.cells);
    s = notebookReducer(s, { type: "add", index: 1, cell: c });
    expect(s.cells.map((x) => x.id)).toEqual(["a", c.id, "b"]);
    s = notebookReducer(s, { type: "move", id: c.id, delta: 1 });
    expect(s.cells.map((x) => x.id)).toEqual(["a", "b", c.id]);
    s = notebookReducer(s, { type: "move", id: c.id, delta: 1 }); // already last
    expect(s.cells.map((x) => x.id)).toEqual(["a", "b", c.id]);
    s = notebookReducer(s, { type: "remove", id: "a" });
    expect(s.cells.map((x) => x.id)).toEqual(["b", c.id]);
  });

  it("reorders cells by drag and drop", () => {
    let s = notebookReducer(state(), { type: "add", index: 2, cell: cell("c", "z = 1") });
    s = notebookReducer(s, { type: "reorder", id: "c", over: "a" });
    expect(s.cells.map((x) => x.id)).toEqual(["c", "a", "b"]);
    s = notebookReducer(s, { type: "reorder", id: "c", over: "b" });
    expect(s.cells.map((x) => x.id)).toEqual(["a", "b", "c"]);
    const same = notebookReducer(s, { type: "reorder", id: "a", over: "a" });
    expect(same).toBe(s);
  });

  it("times runs: cells that ran, their total, failures", () => {
    let s = notebookReducer(state(), { type: "run", cells: state().cells, at: 1000 });
    for (const a of [st("a", "queued"), st("b", "queued"), st("a", "running"), st("a", "done", 120), st("b", "running"), st("b", "error", 30)]) {
      s = notebookReducer(s, a);
    }
    expect(s.current?.queued).toEqual(["a", "b"]);
    s = notebookReducer(s, { type: "finished", at: 1400 });
    expect(s.current).toBeNull();
    expect(s.lastRun).toEqual({ startedAt: 1000, finishedAt: 1400, cells: 2, computeMs: 150, failed: 1 });
    expect(totalElapsed(s)).toBe(150);
  });

  it("does not count cells an interrupt un-queued", () => {
    let s = notebookReducer(state(), { type: "run", cells: state().cells, at: 0 });
    for (const a of [st("a", "queued"), st("b", "queued"), st("a", "running"), st("a", "cancelled", 50), st("b", "done", 1)]) {
      s = notebookReducer(s, a);
    }
    s = notebookReducer(s, { type: "finished", at: 60 });
    expect(s.lastRun?.cells).toBe(1);
    expect(s.lastRun?.computeMs).toBe(50);
  });

  it("clears the outputs of chosen cells and keeps the last run", () => {
    let s = notebookReducer(state(), { type: "run", cells: state().cells, at: 0 });
    s = notebookReducer(s, st("a", "done", 120));
    s = notebookReducer(s, st("b", "done", 30));
    s = notebookReducer(s, { type: "finished", at: 200 });
    const lastRun = s.lastRun;
    s = notebookReducer(s, { type: "progress", data: { cell_id: "a", queries: [] } });
    s = notebookReducer(s, { type: "clearOutputs", cells: ["a"] });
    expect(s.states.a).toEqual({ status: "idle", stale: false, output: null, streams: [], elapsed_ms: null });
    expect(s.states.b.status).toBe("done");
    expect(s.progress).toEqual({});
    expect(s.lastRun).toBe(lastRun);
    expect(totalElapsed(s)).toBe(30);
  });

  it("keeps outputs after a restart, shown as stale", () => {
    let s = notebookReducer(state(), { type: "run", cells: state().cells, at: 0 });
    s = notebookReducer(s, st("a", "done", 120));
    s = notebookReducer(s, { type: "finished", at: 200 });
    s = notebookReducer(s, { type: "restarted" });
    expect(s.states.a.status).toBe("done");
    expect(s.states.a.stale).toBe(true);
    expect(isStale(s, s.cells[0])).toBe(true);
    expect(s.running).toBe(false);
  });

  it("clears every cell's outputs but leaves running cells as they are", () => {
    let s = notebookReducer(state(), { type: "run", cells: state().cells, at: 0 });
    s = notebookReducer(s, st("a", "running"));
    s = notebookReducer(s, { type: "clearOutputs", cells: null });
    expect(s.states.a.status).toBe("running");
    expect(s.states.b.status).toBe("idle");
    expect(s.states.b.output).toBeNull();
  });

  it("names SQL results uniquely", () => {
    const cells = [{ ...cell("s1", "", "sql"), output: "df_1" }, { ...cell("s2", "", "sql"), output: "df_3" }];
    expect(nextResultName(cells)).toBe("df_2");
    expect(makeCell("sql", cells).output).toBe("df_2");
    expect(makeCell("python", cells).output).toBeNull();
  });
});

describe("newCellId", () => {
  it("makes 8 characters of a-z and 0-9, as the kernel does (they are written in the notebook file)", () => {
    const ids = Array.from({ length: 100 }, newCellId);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{8}$/);
    expect(new Set(ids).size).toBe(100);
    expect(makeCell("python", []).id).toMatch(/^[a-z0-9]{8}$/);
  });
});

describe("notebook state with a setup cell", () => {
  const setup: Cell = { ...cell("setup", "import marimo as mo\nws = None"), name: "setup", setup: true };
  const withSetup = (): NotebookState =>
    initialState({ path: "nb.py", cells: [setup, cell("a", "x = 1"), cell("b", "y = x")], states: {} });
  const ids = (s: NotebookState) => s.cells.map((c) => c.id);

  it("hides the setup cell and finds it", () => {
    const s = withSetup();
    expect(visibleCells(s.cells).map((c) => c.id)).toEqual(["a", "b"]);
    expect(setupCell(s.cells)?.id).toBe("setup");
    const plain = state();
    expect(visibleCells(plain.cells)).toBe(plain.cells);
  });

  it("adds cells by visible position: at the top they go after the setup cell", () => {
    let s = notebookReducer(withSetup(), { type: "add", index: 0, cell: cell("t", "") });
    expect(ids(s)).toEqual(["setup", "t", "a", "b"]);
    s = notebookReducer(s, { type: "add", index: 3, cell: cell("e", "") });
    expect(ids(s)).toEqual(["setup", "t", "a", "b", "e"]);
    s = notebookReducer(s, { type: "add", index: 2, cell: cell("m", "") });
    expect(ids(s)).toEqual(["setup", "t", "a", "m", "b", "e"]);
    expect(fullIndex([setup], 0)).toBe(1);
    expect(fullIndex([setup], 5)).toBe(1);
  });

  it("moves cells past each other but never past the setup cell", () => {
    let s = withSetup();
    expect(notebookReducer(s, { type: "move", id: "a", delta: -1 })).toBe(s);
    s = notebookReducer(s, { type: "move", id: "a", delta: 1 });
    expect(ids(s)).toEqual(["setup", "b", "a"]);
    expect(notebookReducer(s, { type: "move", id: "a", delta: 1 })).toBe(s);
    expect(notebookReducer(s, { type: "move", id: "setup", delta: 1 })).toBe(s);
  });

  it("reorders visible cells only, and cannot delete the setup cell", () => {
    let s = withSetup();
    expect(notebookReducer(s, { type: "reorder", id: "a", over: "setup" })).toBe(s);
    expect(notebookReducer(s, { type: "remove", id: "setup" })).toBe(s);
    s = notebookReducer(s, { type: "reorder", id: "b", over: "a" });
    expect(ids(s)).toEqual(["setup", "b", "a"]);
  });

  it("edits the setup code like any cell's", () => {
    const s = notebookReducer(withSetup(), { type: "edit", id: "setup", patch: { code: "import marimo as mo" } });
    expect(s.dirty).toBe(true);
    expect(setupCell(s.cells)?.code).toBe("import marimo as mo");
  });

  it("reports the first line of a setup failure, until the code is edited", () => {
    let s = withSetup();
    expect(setupError(s)).toBeNull();
    const error = { type: "error" as const, ename: "ModuleNotFoundError", evalue: "No module named 'foo'\nsecond line", traceback: "" };
    s = notebookReducer(s, { type: "run", cells: s.cells, at: 0 });
    s = notebookReducer(s, { type: "cell.state", data: { cell_id: "setup", status: "error", stale: false, output: error, streams: [], elapsed_ms: 1 } });
    expect(setupError(s)).toBe("ModuleNotFoundError: No module named 'foo'");
    s = notebookReducer(s, { type: "edit", id: "setup", patch: { code: "import foo" } });
    expect(setupError(s)).toBeNull();
  });
});
