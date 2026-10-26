import { describe, expect, it } from "vitest";

import { layoutJson, parseLayout, placeNew } from "./layout";

const item = (widget: string, x = 0, y = 0, w = 6, h = 8) => ({ widget, x, y, w, h });

describe("parseLayout", () => {
  it("reads a layout and drops a widget placed twice", () => {
    const json = JSON.stringify([item("aaaaaaaa"), item("bbbbbbbb", 6), item("aaaaaaaa", 0, 20)]);
    expect(parseLayout(json)).toEqual([item("aaaaaaaa"), item("bbbbbbbb", 6)]);
  });

  it("takes an empty layout", () => {
    expect(parseLayout("[]")).toEqual([]);
  });

  it("takes a widget that fills the grid", () => {
    expect(parseLayout(JSON.stringify([item("aaaaaaaa", 0, 0, 12, 40)]))).toHaveLength(1);
  });

  it.each([
    ["not json", /not valid JSON/],
    ["{}", /is a list/],
    ["[1]", /layout item 1/],
    [JSON.stringify([item("short")]), /widget is a widget id/],
    [JSON.stringify([item("aaaaaaaa", -1)]), /x and w/],
    [JSON.stringify([item("aaaaaaaa", 8, 0, 6)]), /x and w/],
    [JSON.stringify([item("aaaaaaaa", 0, 0, 0)]), /x and w/],
    [JSON.stringify([item("aaaaaaaa", 0, 0, 13)]), /x and w/],
    [JSON.stringify([item("aaaaaaaa", 0, 0.5)]), /y is/],
    [JSON.stringify([item("aaaaaaaa", 0, -1)]), /y is/],
    [JSON.stringify([item("aaaaaaaa", 0, 0, 6, 41)]), /h is/],
    [JSON.stringify([item("aaaaaaaa", 0, 0, 6, 0)]), /h is/],
  ])("refuses %s", (json, error) => {
    expect(() => parseLayout(json)).toThrow(error);
  });
});

describe("layoutJson", () => {
  it("round-trips, with a trailing newline and only the known keys", () => {
    const items = [item("aaaaaaaa"), item("bbbbbbbb", 6, 0, 6, 4)];
    const text = layoutJson([{ ...items[0], extra: 1 } as never, items[1]]);
    expect(text.endsWith("]\n")).toBe(true);
    expect(text).not.toContain("extra");
    expect(parseLayout(text)).toEqual(items);
    expect(layoutJson([])).toBe("[]\n");
  });
});

describe("placeNew", () => {
  it("goes below everything, at the left edge", () => {
    expect(placeNew([], "cccccccc")).toEqual(item("cccccccc"));
    expect(placeNew([item("aaaaaaaa", 0, 0, 6, 8), item("bbbbbbbb", 6, 2, 6, 10)], "cccccccc", 12, 4)).toEqual(item("cccccccc", 0, 12, 12, 4));
  });
});
