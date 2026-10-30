import { describe, expect, it } from "vitest";

import { styleOf, withDecimals, withStyle } from "./measureFormat";

describe("measureFormat", () => {
  it("reads the style, automatic without a format", () => {
    expect(styleOf(undefined)).toBe("auto");
    expect(styleOf({ style: "percent" })).toBe("percent");
  });

  it("picks a style: automatic clears, currency defaults to BRL, the others drop the currency", () => {
    expect(withStyle({ style: "number", decimals: 1 }, "auto")).toBeNull();
    expect(withStyle(undefined, "currency")).toEqual({ style: "currency", currency: "BRL" });
    expect(withStyle({ style: "currency", currency: "EUR", decimals: 2, compact: true }, "currency")).toEqual({ style: "currency", currency: "EUR", decimals: 2, compact: true });
    expect(withStyle({ style: "currency", currency: "EUR", decimals: 2 }, "percent")).toEqual({ style: "percent", decimals: 2 });
  });

  it("types decimals between 0 and 10, empty meaning as many as come, and nothing while automatic", () => {
    expect(withDecimals({ style: "number" }, "2")).toEqual({ style: "number", decimals: 2 });
    expect(withDecimals({ style: "number", decimals: 2 }, "")).toEqual({ style: "number" });
    expect(withDecimals({ style: "number" }, "99")).toEqual({ style: "number", decimals: 10 });
    expect(withDecimals({ style: "number" }, "-3")).toEqual({ style: "number", decimals: 0 });
    expect(withDecimals({ style: "number", decimals: 1 }, "abc")).toEqual({ style: "number" });
    expect(withDecimals(undefined, "2")).toBeNull();
  });
});
