import { describe, expect, it } from "vitest";

import { coerce, detectParams, mergeSpecs, resolveParams, shown } from "./queryParams";

describe("detectParams", () => {
  it("finds placeholders in order of first appearance, once each", () => {
    expect(detectParams("select * from t where a = :b and c > :a and d = :b")).toEqual(["b", "a"]);
  });

  it("ignores strings, comments and casts", () => {
    const sql = [
      "select ':in_string', \":in_ident\", 'it''s :still', x::int, y::text -- :line",
      "/* :block */ from t where z = :real and w = $$ :dollar $$ and q = $tag$ :tagged $tag$",
    ].join("\n");
    expect(detectParams(sql)).toEqual(["real"]);
  });

  it("leaves positional placeholders and bare colons alone", () => {
    expect(detectParams("select $1, ?, a[1:2], 'x' from t where b = :n")).toEqual(["n"]);
    expect(detectParams("select 1")).toEqual([]);
  });

  it("copes with unterminated quotes and comments", () => {
    expect(detectParams("select :a, 'oops :b")).toEqual(["a"]);
    expect(detectParams("select :a /* :b")).toEqual(["a"]);
  });
});

describe("mergeSpecs", () => {
  it("keeps saved specs of detected names, defaults the rest to text, drops stale ones", () => {
    const saved = { region: { type: "select" as const, options: ["a"] }, gone: { type: "number" as const } };
    const merged = mergeSpecs(["n", "region"], saved);
    expect(merged).toEqual({ n: { type: "text" }, region: { type: "select", options: ["a"] } });
    expect(Object.keys(merged)).toEqual(["n", "region"]);
    expect(mergeSpecs(["a"], null)).toEqual({ a: { type: "text" } });
    expect(mergeSpecs([], saved)).toEqual({});
  });
});

describe("coerce", () => {
  it("numbers", () => {
    expect(coerce({ type: "number" }, "12.5")).toBe(12.5);
    expect(coerce({ type: "number" }, 3)).toBe(3);
    expect(coerce({ type: "number" }, "")).toBeUndefined();
    expect(coerce({ type: "number" }, "abc")).toBeUndefined();
  });
  it("booleans always have a value", () => {
    expect(coerce({ type: "boolean" }, true)).toBe(true);
    expect(coerce({ type: "boolean" }, "true")).toBe(true);
    expect(coerce({ type: "boolean" }, undefined)).toBe(false);
  });
  it("dates are ISO strings", () => {
    expect(coerce({ type: "date" }, "2026-02-28")).toBe("2026-02-28");
    expect(coerce({ type: "date" }, "2026-02-30")).toBeUndefined();
    expect(coerce({ type: "date" }, "28/02/2026")).toBeUndefined();
    expect(coerce({ type: "date" }, "")).toBeUndefined();
  });
  it("selects must be one of the options", () => {
    expect(coerce({ type: "select", options: ["a", "b"] }, "b")).toBe("b");
    expect(coerce({ type: "select", options: ["a", "b"] }, "c")).toBeUndefined();
  });
  it("text", () => {
    expect(coerce({ type: "text" }, "EU")).toBe("EU");
    expect(coerce({ type: "text" }, "")).toBeUndefined();
  });
});

describe("resolveParams", () => {
  const specs = {
    region: { type: "text" as const, default: "EU" },
    since: { type: "date" as const },
    n: { type: "number" as const, default: 10 },
    flag: { type: "boolean" as const },
  };

  it("uses typed values over defaults and reports the missing", () => {
    const r = resolveParams(specs, { n: "3", flag: true });
    expect(r.missing).toEqual(["since"]);
    expect(r.query.params).toEqual({ region: "EU", n: 3, flag: true });
    expect(r.query.param_types).toEqual({ region: "text", n: "number", flag: "boolean" });
  });

  it("sends the types with the values", () => {
    const r = resolveParams(specs, { since: "2026-01-01" });
    expect(r.missing).toEqual([]);
    expect(r.query.params).toMatchObject({ since: "2026-01-01", n: 10, flag: false });
    expect(r.query.param_types?.since).toBe("date");
  });

  it("sends nothing for a query without parameters", () => {
    expect(resolveParams({}, {})).toEqual({ query: {}, missing: [] });
  });

  it("shows the default until a value is typed", () => {
    expect(shown(specs.n, undefined)).toBe("10");
    expect(shown(specs.n, "")).toBe("");
    expect(shown(specs.flag, undefined)).toBe(false);
  });
});
