import { describe, expect, it } from "vitest";

import { initialWindow, keepInside, shownQuery } from "./planWindowRules";

describe("initialWindow", () => {
  it("opens at 1100 by 680, centered, in a large viewport", () => {
    expect(initialWindow({ width: 1920, height: 1080 })).toEqual({ left: 410, top: 200, width: 1100, height: 680 });
  });

  it("fits a small viewport, keeping a margin", () => {
    expect(initialWindow({ width: 1000, height: 500 })).toEqual({ left: 24, top: 24, width: 952, height: 452 });
  });
});

describe("keepInside", () => {
  const size = { width: 900, height: 600 };
  const viewport = { width: 1920, height: 1080 };

  it("leaves a window inside the viewport where it is", () => {
    expect(keepInside({ left: 100, top: 200 }, size, viewport)).toEqual({ left: 100, top: 200 });
  });

  it("pulls a window dragged off the edges back in", () => {
    expect(keepInside({ left: -40, top: 900 }, size, viewport)).toEqual({ left: 0, top: 480 });
    expect(keepInside({ left: 1500, top: -5 }, size, viewport)).toEqual({ left: 1020, top: 0 });
  });

  it("keeps the top-left corner when the window is bigger than the viewport", () => {
    expect(keepInside({ left: 50, top: 50 }, { width: 2000, height: 2000 }, viewport)).toEqual({ left: 0, top: 0 });
  });
});

describe("shownQuery", () => {
  it("shows the latest query until one is picked", () => {
    expect(shownQuery(null, 3)).toBe(2);
  });

  it("keeps a picked query, and falls back to the latest when it is gone", () => {
    expect(shownQuery(0, 3)).toBe(0);
    expect(shownQuery(4, 3)).toBe(2);
  });
});
