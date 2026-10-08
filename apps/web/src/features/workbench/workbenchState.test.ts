import { describe, expect, it } from "vitest";

import { activePath, emptyWorkbench, MAX_PANES, openPaths, parseWorkbench, workbenchReducer, type WorkbenchAction, type WorkbenchState } from "./workbenchState";

function apply(state: WorkbenchState, ...actions: WorkbenchAction[]): WorkbenchState {
  return actions.reduce(workbenchReducer, state);
}

const tabs = (s: WorkbenchState) => s.panes.map((p) => p.tabs);

describe("workbench", () => {
  it("opens tabs after the active one and re-shows open notebooks", () => {
    let s = apply(emptyWorkbench(), { type: "open", path: "a" }, { type: "open", path: "b" }, { type: "activate", pane: "p1", path: "a" }, { type: "open", path: "c" });
    expect(tabs(s)).toEqual([["a", "c", "b"]]);
    s = apply(s, { type: "open", path: "b" });
    expect(tabs(s)).toEqual([["a", "c", "b"]]);
    expect(activePath(s)).toBe("b");
  });

  it("opens to the side in new panes, up to four, then in the next pane", () => {
    let s = apply(emptyWorkbench(), { type: "open", path: "a" });
    for (const p of ["b", "c", "d"]) s = apply(s, { type: "openToSide", path: p });
    expect(tabs(s)).toEqual([["a"], ["b"], ["c"], ["d"]]);
    expect(s.panes).toHaveLength(MAX_PANES);
    expect(activePath(s)).toBe("d");
    s = apply(s, { type: "openToSide", path: "e" });
    expect(tabs(s)).toEqual([["a", "e"], ["b"], ["c"], ["d"]]);
    expect(s.focused).toBe("p1");
  });

  it("a notebook lives in one pane: opening it to the side moves it", () => {
    let s = apply(emptyWorkbench(), { type: "open", path: "a" }, { type: "open", path: "b" }, { type: "openToSide", path: "a" });
    expect(tabs(s)).toEqual([["b"], ["a"]]);
    s = apply(s, { type: "moveTab", path: "a", to: "p1" });
    expect(tabs(s)).toEqual([["b", "a"]]);
    expect(openPaths(s).sort()).toEqual(["a", "b"]);
  });

  it("closing the last tab of a pane closes the pane, but not other empty panes", () => {
    let s = apply(emptyWorkbench(), { type: "open", path: "a" }, { type: "openToSide", path: "b" }, { type: "split", pane: "p2" });
    expect(s.panes.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    s = apply(s, { type: "close", pane: "p2", path: "b" });
    expect(s.panes.map((p) => p.id)).toEqual(["p1", "p3"]);
    s = apply(s, { type: "close", pane: "p1", path: "a" });
    expect(s.panes.map((p) => p.id)).toEqual(["p3"]);
    expect(s.focused).toBe("p3");
  });

  it("closes deleted notebooks and merges closed panes", () => {
    let s = apply(emptyWorkbench(), { type: "open", path: "a" }, { type: "open", path: "x" }, { type: "openToSide", path: "b" }, { type: "open", path: "c" });
    s = apply(s, { type: "closePath", path: "x" });
    expect(tabs(s)).toEqual([["a"], ["b", "c"]]);
    s = apply(s, { type: "closePane", pane: "p1" });
    expect(tabs(s)).toEqual([["b", "c", "a"]]);
    expect(apply(s, { type: "closePane", pane: "p2" })).toBe(s);
  });

  it("reorders tabs and closes the others", () => {
    let s = apply(emptyWorkbench(), { type: "open", path: "a" }, { type: "open", path: "b" }, { type: "open", path: "c" });
    s = apply(s, { type: "reorderTab", pane: "p1", path: "c", over: "a" });
    expect(tabs(s)).toEqual([["c", "a", "b"]]);
    s = apply(s, { type: "closeOthers", pane: "p1", path: "a" });
    expect(tabs(s)).toEqual([["a"]]);
  });

  it("restores only well-formed state", () => {
    expect(parseWorkbench(null)).toBeNull();
    expect(parseWorkbench({ panes: [] })).toBeNull();
    const s = parseWorkbench({ panes: [{ id: "p1", tabs: ["a", 3, "a"], active: "zz" }, { id: "p2", tabs: ["a", "b"] }], focused: "nope", arrangement: "weird" });
    expect(s).toEqual({ panes: [{ id: "p1", tabs: ["a"], active: "a" }, { id: "p2", tabs: ["b"], active: "b" }], focused: "p1", arrangement: "columns" });
  });

  it("follows renamed files and folders, and closes deleted ones", () => {
    let s = workbenchReducer(emptyWorkbench(), { type: "open", path: "nb/a.py" });
    s = workbenchReducer(s, { type: "openToSide", path: "nb/sub/b.py" });
    s = workbenchReducer(s, { type: "rename", from: "nb/sub", to: "old" });
    expect(s.panes.map((p) => p.tabs)).toEqual([["nb/a.py"], ["old/b.py"]]);
    expect(s.panes[1].active).toBe("old/b.py");
    s = workbenchReducer(s, { type: "rename", from: "nb/a.py", to: "nb/c.py" });
    expect(s.panes[0].active).toBe("nb/c.py");
    s = workbenchReducer(s, { type: "closeWithin", path: "old" });
    expect(s.panes.map((p) => p.tabs)).toEqual([["nb/c.py"]]);
  });
});
