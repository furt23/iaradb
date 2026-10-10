import { describe, expect, it } from "vitest";

import { dataTabsReducer, emptyDataTabs, parseDataTabs, type DataTabs, type DataTabsAction } from "./dataTabsState";

const run = (...actions: DataTabsAction[]): DataTabs => actions.reduce(dataTabsReducer, emptyDataTabs());

describe("data tabs", () => {
  it("opens tables next to the active one and re-shows open ones", () => {
    let s = run({ type: "open", name: "a" }, { type: "open", name: "b" }, { type: "open", name: "c" });
    expect(s).toEqual({ tabs: ["a", "b", "c"], active: "c" });
    s = dataTabsReducer(s, { type: "open", name: "a" });
    expect(s).toEqual({ tabs: ["a", "b", "c"], active: "a" });
    s = dataTabsReducer(s, { type: "open", name: "d" });
    expect(s).toEqual({ tabs: ["a", "d", "b", "c"], active: "d" });
  });

  it("closing the active tab shows its neighbour", () => {
    const s = run({ type: "open", name: "a" }, { type: "open", name: "b" }, { type: "open", name: "c" }, { type: "open", name: "b" });
    expect(dataTabsReducer(s, { type: "close", name: "b" })).toEqual({ tabs: ["a", "c"], active: "c" });
    expect(dataTabsReducer(s, { type: "close", name: "a" })).toEqual({ tabs: ["b", "c"], active: "b" });
    const last = run({ type: "open", name: "a" }, { type: "close", name: "a" });
    expect(last).toEqual({ tabs: [], active: null });
  });

  it("closes others, all, and tables that left the catalog", () => {
    const s = run({ type: "open", name: "a" }, { type: "open", name: "b" }, { type: "open", name: "c" });
    expect(dataTabsReducer(s, { type: "closeOthers", name: "b" })).toEqual({ tabs: ["b"], active: "b" });
    expect(dataTabsReducer(s, { type: "closeAll" })).toEqual(emptyDataTabs());
    expect(dataTabsReducer(s, { type: "keep", names: ["a", "b"] })).toEqual({ tabs: ["a", "b"], active: "b" });
    expect(dataTabsReducer(s, { type: "keep", names: ["a", "b", "c", "d"] })).toBe(s);
  });

  it("reorders tabs", () => {
    const s = run({ type: "open", name: "a" }, { type: "open", name: "b" }, { type: "open", name: "c" });
    expect(dataTabsReducer(s, { type: "reorder", name: "c", over: "a" }).tabs).toEqual(["c", "a", "b"]);
  });

  it("restores stored tabs defensively", () => {
    expect(parseDataTabs({ tabs: ["a", "a", 3, "b"], active: "x" })).toEqual({ tabs: ["a", "b"], active: "a" });
    expect(parseDataTabs(null)).toBeNull();
    expect(parseDataTabs({ tabs: "a" })).toBeNull();
  });
});
