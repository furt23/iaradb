import { describe, expect, it } from "vitest";

import { joinQuery, splitQuery } from "./queryHeader";

const chart = { kind: "bar" as const, x: "region", y: ["revenue"], agg: "sum" as const, group: null };

describe("query header", () => {
  it("round-trips a chart above the query", () => {
    const text = joinQuery(chart, "select 1\n");
    expect(text.split("\n")[0]).toBe('-- workhouse:chart {"kind":"bar","x":"region","y":["revenue"],"agg":"sum","group":null}');
    expect(splitQuery(text)).toEqual({ chart, body: "select 1\n" });
  });

  it("leaves plain queries and foreign comments alone", () => {
    expect(splitQuery("select 1")).toEqual({ chart: null, body: "select 1" });
    expect(splitQuery("-- workhouse:chart oops\nselect 1")).toEqual({ chart: null, body: "-- workhouse:chart oops\nselect 1" });
    expect(joinQuery(null, "select 1")).toBe("select 1");
  });

  it("reads Windows line endings and a header-only file", () => {
    expect(splitQuery(joinQuery(chart, "").replace("\n", "\r\n"))).toEqual({ chart, body: "" });
  });
});
