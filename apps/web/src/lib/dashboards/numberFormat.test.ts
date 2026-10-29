import { describe, expect, it } from "vitest";

import { formatNumber, numberLocale } from "./numberFormat";

/** Intl puts a non-breaking space after "R$"; compare with a plain space. */
const plain = (s: string) => s.replace(/\s/g, " ");

describe("numberLocale", () => {
  it("is pt-BR for Portuguese and en-US for anything else", () => {
    expect(numberLocale("pt")).toBe("pt-BR");
    expect(numberLocale("pt-BR")).toBe("pt-BR");
    expect(numberLocale("en")).toBe("en-US");
    expect(numberLocale("fr")).toBe("en-US");
  });
});

describe("formatNumber", () => {
  it("writes currency in the locale, with the fixed decimals", () => {
    expect(plain(formatNumber(1234.5, { style: "currency", currency: "BRL", decimals: 2 }, "pt-BR"))).toBe("R$ 1.234,50");
  });

  it("writes a fraction as a percent", () => {
    expect(formatNumber(0.256, { style: "percent", decimals: 1 }, "pt-BR")).toBe("25,6%");
  });

  it("writes compact numbers with Intl's two significant digits", () => {
    expect(formatNumber(1234567, { style: "number", compact: true }, "en-US")).toBe("1.2M");
  });

  it("writes up to 2 decimals without a format", () => {
    expect(formatNumber(3.14159, undefined, "en-US")).toBe("3.14");
  });

  it("writes the decimals a format asks for, even when there are none to drop", () => {
    expect(formatNumber(2, { style: "number", decimals: 2 }, "en-US")).toBe("2.00");
  });

  it("writes a value that is not finite as String() does", () => {
    expect(formatNumber(NaN, undefined, "en-US")).toBe("NaN");
    expect(formatNumber(-Infinity, { style: "percent" }, "en-US")).toBe("-Infinity");
  });
});
