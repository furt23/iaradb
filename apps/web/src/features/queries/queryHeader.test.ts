import { describe, expect, it } from "vitest";

import { joinQuery, splitQuery } from "./queryHeader";

const chart = { kind: "bar" as const, x: "region", y: ["revenue"], agg: "sum" as const, group: null };
const CHART_LINE = '-- iara:chart {"kind":"bar","x":"region","y":["revenue"],"agg":"sum","group":null}';
const PARAMS = { region: { type: "text" as const, default: "EU" }, n: { type: "number" as const, default: 10 }, tier: { type: "select" as const, options: ["a", "b"], default: "a" } };
const PARAMS_LINE = `-- iara:params ${JSON.stringify(PARAMS)}`;

describe("query header", () => {
  it("round-trips a chart above the query", () => {
    const text = joinQuery({ chart, params: null, body: "select 1\n" });
    expect(text.split("\n")[0]).toBe(CHART_LINE);
    expect(splitQuery(text)).toMatchObject({ chart, params: null, body: "select 1\n" });
  });

  it("is byte-stable for files that only carry a chart", () => {
    const text = `${CHART_LINE}\nselect * from t\n`;
    expect(joinQuery(splitQuery(text))).toBe(text);
  });

  it("leaves plain queries and foreign comments alone", () => {
    expect(splitQuery("select 1")).toMatchObject({ chart: null, params: null, body: "select 1" });
    expect(splitQuery("-- iara:chart oops\nselect 1")).toMatchObject({ chart: null, body: "-- iara:chart oops\nselect 1" });
    expect(splitQuery("-- just a comment\nselect 1")).toMatchObject({ body: "-- just a comment\nselect 1" });
    expect(joinQuery({ chart: null, params: null, body: "select 1" })).toBe("select 1");
  });

  it("reads Windows line endings and a header-only file", () => {
    const text = joinQuery({ chart, params: null, body: "" }).replace("\n", "\r\n");
    expect(splitQuery(text)).toMatchObject({ chart, body: "" });
  });

  it("reads a chart and parameters, in any order, and writes chart first", () => {
    const text = `${PARAMS_LINE}\n${CHART_LINE}\nselect :region\n`;
    const parts = splitQuery(text);
    expect(parts).toMatchObject({ chart, params: PARAMS, body: "select :region\n" });
    expect(joinQuery(parts)).toBe(`${CHART_LINE}\n${PARAMS_LINE}\nselect :region\n`);
  });

  it("reads parameters alone and drops the line when there are none", () => {
    const parts = splitQuery(`${PARAMS_LINE}\nselect 1`);
    expect(parts).toMatchObject({ chart: null, params: PARAMS, body: "select 1" });
    expect(joinQuery({ ...parts, params: {} })).toBe("select 1");
    expect(joinQuery({ ...parts, params: null })).toBe("select 1");
  });

  it("defaults an unknown or missing param type to text", () => {
    const parts = splitQuery('-- iara:params {"a":{"type":"weird"},"b":{}}\nselect 1');
    expect(parts.params).toEqual({ a: { type: "text" }, b: { type: "text" } });
  });

  it("keeps lines of unknown keys as written, where they were", () => {
    const text = `-- iara:owner {"team":"data"}\n${CHART_LINE}\n-- iara:note free text\nselect 1\n`;
    const parts = splitQuery(text);
    expect(parts.body).toBe("select 1\n");
    expect(parts.extra.map((e) => e.line)).toEqual(['-- iara:owner {"team":"data"}', "-- iara:note free text"]);
    expect(joinQuery(parts)).toBe(text);
    // new parameters slot in without disturbing them
    expect(joinQuery({ ...parts, params: PARAMS })).toBe(`-- iara:owner {"team":"data"}\n${CHART_LINE}\n-- iara:note free text\n${PARAMS_LINE}\nselect 1\n`);
  });

  it("stops at a malformed known line, which stays in the query", () => {
    const text = `${CHART_LINE}\n-- iara:params nope\nselect 1`;
    const parts = splitQuery(text);
    expect(parts.chart).toEqual(chart);
    expect(parts.params).toBeNull();
    expect(parts.body).toBe("-- iara:params nope\nselect 1");
    expect(joinQuery(parts)).toBe(text);
  });
});
