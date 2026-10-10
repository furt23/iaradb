import { describe, expect, it } from "vitest";

import { railExpandedFrom, railStoredValue } from "./railPrefs";

describe("rail preference", () => {
  it("is expanded unless the browser stored collapsed", () => {
    expect(railExpandedFrom(null)).toBe(true);
    expect(railExpandedFrom(undefined)).toBe(true);
    expect(railExpandedFrom("expanded")).toBe(true);
    expect(railExpandedFrom("collapsed")).toBe(false);
    expect(railExpandedFrom("something else")).toBe(true);
  });

  it("stores a value that reads back", () => {
    expect(railStoredValue(true)).toBe("expanded");
    expect(railStoredValue(false)).toBe("collapsed");
    expect(railExpandedFrom(railStoredValue(false))).toBe(false);
    expect(railExpandedFrom(railStoredValue(true))).toBe(true);
  });
});
