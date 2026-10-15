import type { NotebookView, WidgetDefinition, WidgetsState } from "@iara/protocol";
import { describe, expect, it } from "vitest";

import { initialState, notebookReducer } from "./notebookState";
import { inputText, parseNumber, pickChoice, sameValue, valueToSend } from "./widgets";

const def = (patch: Partial<WidgetDefinition>): WidgetDefinition => ({
  name: "w",
  kind: "text",
  label: "w",
  default: "",
  choices: null,
  min: null,
  max: null,
  step: null,
  ...patch,
});

describe("widget helpers", () => {
  it("parses number input and clamps it", () => {
    expect(parseNumber("12.5", { min: null, max: null })).toBe(12.5);
    expect(parseNumber(" 7 ", { min: 0, max: 5 })).toBe(5);
    expect(parseNumber("-3", { min: 0, max: null })).toBe(0);
    expect(parseNumber("", { min: null, max: null })).toBeNull();
    expect(parseNumber("-", { min: null, max: null })).toBeNull();
    expect(parseNumber("abc", { min: null, max: null })).toBeNull();
  });

  it("decides what to send", () => {
    expect(valueToSend(def({ kind: "number" }), "4")).toBe(4);
    expect(valueToSend(def({ kind: "number" }), "")).toBeNull();
    expect(valueToSend(def({ kind: "text" }), "")).toBe("");
  });

  it("shows values as input text and compares them", () => {
    expect(inputText(null)).toBe("");
    expect(inputText(3)).toBe("3");
    expect(inputText(["a", "b"])).toBe("a, b");
    expect(sameValue(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameValue(["a"], ["a", "b"])).toBe(false);
    expect(sameValue("1", 1)).toBe(false);
  });

  it("keeps numeric choices numeric", () => {
    expect(pickChoice({ choices: [1, 2, 3] }, "2")).toBe(2);
    expect(pickChoice({ choices: ["a", "b"] }, "b")).toBe("b");
  });
});

describe("widgets in the notebook state", () => {
  const view: NotebookView = { path: "nb.py", cells: [], states: {} };
  const widgets: WidgetsState = { definitions: [def({ name: "n", kind: "number", default: 1 })], values: { n: 1 } };

  it("starts without widgets, or with the kernel's", () => {
    expect(initialState(view).widgets).toEqual({ definitions: [], values: {} });
    expect(initialState({ ...view, widgets }).widgets).toBe(widgets);
  });

  it("follows the kernel and shows an edit at once", () => {
    let s = notebookReducer(initialState(view), { type: "widgets.changed", data: widgets });
    expect(s.widgets).toBe(widgets);
    s = notebookReducer(s, { type: "widget.value", name: "n", value: 5 });
    expect(s.widgets.values.n).toBe(5);
    expect(s.widgets.definitions).toBe(widgets.definitions);
    // a widget nobody defined is ignored
    expect(notebookReducer(s, { type: "widget.value", name: "zzz", value: 1 })).toBe(s);
  });
});
