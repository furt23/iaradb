import { describe, expect, it } from "vitest";

import { optionText, pickedValue, shownText, textValue, withRangeEnd } from "./filterValue";

describe("optionText", () => {
  it("reads numbers, booleans and structures as text", () => {
    expect(optionText("EU")).toBe("EU");
    expect(optionText(12)).toBe("12");
    expect(optionText(true)).toBe("true");
    expect(optionText({ a: 1 })).toBe('{"a":1}');
  });
});

describe("pickedValue", () => {
  it("keeps numbers as numbers only for number filters", () => {
    expect(pickedValue({ value_type: "number" }, "42")).toBe(42);
    expect(pickedValue({ value_type: "number" }, "4.5")).toBe(4.5);
    expect(pickedValue({ value_type: "text" }, "42")).toBe("42");
    expect(pickedValue({}, "42")).toBe("42");
  });

  it("leaves what is not a number as text", () => {
    expect(pickedValue({ value_type: "number" }, "n/a")).toBe("n/a");
    expect(pickedValue({ value_type: "number" }, " ")).toBe(" ");
  });
});

describe("shownText", () => {
  it("shows one value and nothing else", () => {
    expect(shownText("EU")).toBe("EU");
    expect(shownText(7)).toBe("7");
    for (const v of [undefined, "", true, ["a"], { from: "2026-01-01" }]) expect(shownText(v)).toBeNull();
  });
});

describe("textValue", () => {
  it("is undefined for empty text", () => {
    expect(textValue("text", "")).toBeUndefined();
    expect(textValue("number", "")).toBeUndefined();
  });

  it("types the text by the input", () => {
    expect(textValue("number", "12.5")).toBe(12.5);
    expect(textValue("number", "abc")).toBeUndefined();
    expect(textValue("date", "2026-10-01")).toBe("2026-10-01");
    expect(textValue(undefined, "ab")).toBe("ab");
  });
});

describe("withRangeEnd", () => {
  it("sets one end and keeps the other", () => {
    const from = withRangeEnd(undefined, "from", "2026-01-01");
    expect(from).toEqual({ from: "2026-01-01" });
    expect(withRangeEnd(from, "to", "2026-02-01")).toEqual({ from: "2026-01-01", to: "2026-02-01" });
  });

  it("clears an end, and the filter when both are empty", () => {
    expect(withRangeEnd({ from: "2026-01-01", to: "2026-02-01" }, "from", "")).toEqual({ to: "2026-02-01" });
    expect(withRangeEnd({ from: "2026-01-01" }, "from", "")).toBeUndefined();
  });

  it("starts over when the value was not a range", () => {
    expect(withRangeEnd("x", "to", "2026-02-01")).toEqual({ to: "2026-02-01" });
    expect(withRangeEnd(["a"], "to", "2026-02-01")).toEqual({ to: "2026-02-01" });
  });
});
