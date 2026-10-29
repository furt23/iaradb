import { describe, expect, it } from "vitest";

import { cellTint, columnRange, TONE_COLORS, tintBackground } from "./conditional";
import type { ColumnFormat } from "./types";

const range = { min: 0, max: 10 };

describe("columnRange", () => {
  it("is the lowest and highest numeric value, numeric strings included", () => {
    expect(columnRange([[1, "a"], [null, "b"], ["7.5", "c"], ["-2", "d"], ["n/a", "e"]], 0)).toEqual({ min: -2, max: 7.5 });
  });

  it("is null without a numeric value", () => {
    expect(columnRange([["a"], [null]], 0)).toBeNull();
    expect(columnRange([], 0)).toBeNull();
  });
});

describe("cellTint rules", () => {
  it("takes the first rule a cell matches, at full strength", () => {
    const f: ColumnFormat = { rules: [{ op: ">=", value: 10, tone: "green" }, { op: ">", value: 5, tone: "amber" }] };
    expect(cellTint(f, 12, null)).toEqual({ tone: "green", strength: 1 });
    expect(cellTint(f, 7, null)).toEqual({ tone: "amber", strength: 1 });
    expect(cellTint(f, 1, null)).toBeNull();
  });

  it("compares text with = and != by its characters", () => {
    const f: ColumnFormat = { rules: [{ op: "=", value: "open", tone: "blue" }, { op: "!=", value: "open", tone: "red" }] };
    expect(cellTint(f, "open", null)).toEqual({ tone: "blue", strength: 1 });
    expect(cellTint(f, "closed", null)).toEqual({ tone: "red", strength: 1 });
  });

  it("compares numbers with = numerically when both sides are numeric", () => {
    const f: ColumnFormat = { rules: [{ op: "=", value: 1, tone: "green" }] };
    expect(cellTint(f, "1.0", null)).toEqual({ tone: "green", strength: 1 });
    expect(cellTint(f, "1a", null)).toBeNull();
  });

  it("never matches null", () => {
    expect(cellTint({ rules: [{ op: "!=", value: "x", tone: "red" }] }, null, null)).toBeNull();
  });

  it("does not match a text cell with a number rule", () => {
    expect(cellTint({ rules: [{ op: ">", value: 1, tone: "red" }] }, "abc", null)).toBeNull();
  });

  it("wins over the scale", () => {
    const f: ColumnFormat = { rules: [{ op: ">", value: 9, tone: "red" }], scale: { high: "green" } };
    expect(cellTint(f, 10, range)).toEqual({ tone: "red", strength: 1 });
  });
});

describe("cellTint scale", () => {
  it("grows from none to full toward the highest value without low", () => {
    const f: ColumnFormat = { scale: { high: "green" } };
    expect(cellTint(f, 5, range)).toEqual({ tone: "green", strength: 0.5 });
    expect(cellTint(f, 10, range)).toEqual({ tone: "green", strength: 1 });
    expect(cellTint(f, 0, range)).toBeNull();
  });

  it("fades low out toward the middle and grows high from it, with low", () => {
    const f: ColumnFormat = { scale: { high: "green", low: "red" } };
    expect(cellTint(f, 0, range)).toEqual({ tone: "red", strength: 1 });
    expect(cellTint(f, 2.5, range)).toEqual({ tone: "red", strength: 0.5 });
    expect(cellTint(f, 5, range)).toBeNull();
    expect(cellTint(f, 7.5, range)).toEqual({ tone: "green", strength: 0.5 });
    expect(cellTint(f, 10, range)).toEqual({ tone: "green", strength: 1 });
  });

  it("is full on a flat range", () => {
    expect(cellTint({ scale: { high: "green" } }, 4, { min: 4, max: 4 })).toEqual({ tone: "green", strength: 1 });
  });

  it("tints numeric values only, and only with a range", () => {
    const f: ColumnFormat = { scale: { high: "green" } };
    expect(cellTint(f, "abc", range)).toBeNull();
    expect(cellTint(f, 5, null)).toBeNull();
  });

  it("keeps the strength in (0, 1] for a value outside the range", () => {
    expect(cellTint({ scale: { high: "green" } }, 20, range)).toEqual({ tone: "green", strength: 1 });
  });
});

describe("cellTint without a format", () => {
  it("is null with no format, or a format with nothing to match", () => {
    expect(cellTint(undefined, 5, range)).toBeNull();
    expect(cellTint({ number: { style: "number" } }, 5, range)).toBeNull();
  });
});

describe("tintBackground", () => {
  it("mixes the tone into transparency, at most 40%", () => {
    expect(tintBackground({ tone: "red", strength: 1 })).toBe(`color-mix(in srgb, ${TONE_COLORS.red} 40%, transparent)`);
    expect(tintBackground({ tone: "blue", strength: 0.25 })).toBe(`color-mix(in srgb, ${TONE_COLORS.blue} 10%, transparent)`);
  });
});
