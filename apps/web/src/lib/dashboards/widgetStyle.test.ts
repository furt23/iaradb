import { describe, expect, it } from "vitest";

import { checkChartStyle, checkColumnFormats, checkNumberFormat } from "./widgetStyle";

describe("checkNumberFormat", () => {
  it("keeps the known keys, and the currency only with the currency style", () => {
    expect(checkNumberFormat({ style: "currency", currency: "BRL", decimals: 2, compact: true, extra: 1 }, "format")).toEqual({
      style: "currency",
      currency: "BRL",
      decimals: 2,
      compact: true,
    });
    expect(checkNumberFormat({ style: "percent", currency: "BRL" }, "format")).toEqual({ style: "percent" });
  });

  it.each([
    [null, /format is an object/],
    [{ style: "bars" }, /format style is one of number, currency, percent/],
    [{ style: "number", decimals: 11 }, /decimals is a whole number from 0 to 10/],
    [{ style: "number", decimals: 1.5 }, /decimals/],
    [{ style: "number", decimals: "2" }, /decimals/],
    [{ style: "currency" }, /currency is a 3-letter ISO code/],
    [{ style: "currency", currency: "brl" }, /currency/],
    [{ style: "currency", currency: "REAL" }, /currency/],
    [{ style: "number", compact: "yes" }, /compact is true or false/],
  ])("refuses %j", (value, error) => {
    expect(() => checkNumberFormat(value, "format")).toThrow(error);
  });
});

describe("checkChartStyle", () => {
  it("round-trips a style", () => {
    const style = {
      series: { amount: { axis: "right", as: "line" }, count: {} },
      labels: true,
      format: { style: "currency", currency: "BRL" },
      right_format: { style: "percent", decimals: 0 },
    };
    expect(checkChartStyle(style)).toEqual(style);
  });

  it("drops the keys it does not know, and takes an empty style", () => {
    expect(checkChartStyle({ labels: false, extra: 1 })).toEqual({ labels: false });
    expect(checkChartStyle({})).toEqual({});
  });

  it("keeps a series named __proto__ as a key", () => {
    const style = checkChartStyle(JSON.parse('{"series":{"__proto__":{"as":"bar"}}}'));
    expect(Object.keys(style.series!)).toEqual(["__proto__"]);
  });

  it.each([
    ["x", /style is an object/],
    [{ series: [] }, /series is an object/],
    [{ series: { amount: "bar" } }, /series amount is an object/],
    [{ series: { amount: { axis: "left" } } }, /series amount axis is one of right/],
    [{ series: { amount: { as: "pie" } } }, /series amount as is one of bar, line/],
    [{ labels: "yes" }, /labels is true or false/],
    [{ format: { style: "bars" } }, /format style/],
    [{ right_format: { style: "number", decimals: 99 } }, /right_format decimals/],
  ])("refuses %j", (value, error) => {
    expect(() => checkChartStyle(value)).toThrow(error);
  });
});

describe("checkColumnFormats", () => {
  const formats = {
    amount: {
      number: { style: "currency", currency: "BRL", decimals: 2 },
      rules: [
        { op: "<", value: 0, tone: "red" },
        { op: "=", value: "open", tone: "blue" },
      ],
      scale: { high: "green", low: "red" },
    },
    status: { rules: [{ op: "!=", value: "closed", tone: "amber" }], scale: { high: "blue" } },
  };

  it("round-trips the formats of the columns", () => {
    expect(checkColumnFormats(formats)).toEqual(formats);
  });

  it("drops the keys it does not know", () => {
    expect(checkColumnFormats({ amount: { number: { style: "percent", x: 1 }, y: 2 } })).toEqual({ amount: { number: { style: "percent" } } });
  });

  it("takes at most 20 rules a column", () => {
    const rule = { op: ">", value: 1, tone: "red" };
    expect(checkColumnFormats({ amount: { rules: Array(20).fill(rule) } }).amount.rules).toHaveLength(20);
    expect(() => checkColumnFormats({ amount: { rules: Array(21).fill(rule) } })).toThrow(/at most 20 rules/);
  });

  it.each([
    [[], /formats is an object/],
    [{ amount: "x" }, /format of amount is an object/],
    [{ amount: { number: { style: "bars" } } }, /number of amount style is one of/],
    [{ amount: { rules: "x" } }, /rules of amount is a list of at most 20 rules/],
    [{ amount: { rules: [{ op: "~", value: 1, tone: "red" }] } }, /rule op is one of/],
    [{ amount: { rules: [{ op: ">", value: null, tone: "red" }] } }, /rule value is a number or text/],
    [{ amount: { rules: [{ op: ">", value: 1, tone: "purple" }] } }, /rule tone is one of/],
    [{ amount: { scale: { low: "red" } } }, /scale high is one of/],
    [{ amount: { scale: { high: "green", low: "pink" } } }, /scale low is one of/],
  ])("refuses %j", (value, error) => {
    expect(() => checkColumnFormats(value)).toThrow(error);
  });
});
