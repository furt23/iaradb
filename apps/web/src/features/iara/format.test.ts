import { describe, expect, it } from "vitest";

import { contextPercent } from "./format";

describe("contextPercent", () => {
  it("is the share of the budget in use", () => {
    expect(contextPercent(25, 100)).toBe(25);
    expect(contextPercent(0, 100)).toBe(0);
  });

  it("stays within 0 and 100, and an empty budget is empty", () => {
    expect(contextPercent(300, 100)).toBe(100);
    expect(contextPercent(-5, 100)).toBe(0);
    expect(contextPercent(10, 0)).toBe(0);
  });
});
