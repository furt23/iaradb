import { describe, expect, it } from "vitest";

import { checkedEnv, checkedInitScript, checkedLibraries, checkedMaxHours, checkedTags } from "./clusterSettings";

describe("libraries", () => {
  it("accepts PyPI specs and trims them", () => {
    expect(checkedLibraries([" polars==1.9 ", "scikit-learn>=1.5", "pandas[parquet]", "a~=1.0,<2", "torch==2.4.*"])).toEqual(["polars==1.9", "scikit-learn>=1.5", "pandas[parquet]", "a~=1.0,<2", "torch==2.4.*"]);
  });

  it("rejects unsafe, empty, duplicate and too many specs", () => {
    for (const bad of ["", "-r x", "a'b", "a;b", "a$(x)", "a\nb", "x".repeat(201), "polars=1.9", "git+https://x"]) expect(() => checkedLibraries([bad])).toThrow(/^library "[\s\S]*": /);
    expect(() => checkedLibraries(["polars=1.9"])).toThrow('library "polars=1.9": unknown operator');
    expect(() => checkedLibraries(["Polars", "polars"])).toThrow(/twice/);
    expect(() => checkedLibraries(Array.from({ length: 51 }, (_, i) => `p${i}`))).toThrow(/at most 50/);
  });
});

describe("env", () => {
  it("accepts ordinary variables", () => {
    expect(checkedEnv({ MY_VAR: "a b", _x1: "" })).toEqual({ MY_VAR: "a b", _x1: "" });
  });

  it("rejects bad names, reserved names and bad values", () => {
    for (const name of ["1A", "A-B", "IARA_X", "AWS_REGION", "PATH", "HOME", "PYTHONUNBUFFERED", "PYTHONIOENCODING"]) {
      expect(() => checkedEnv({ [name]: "x" })).toThrow(/invalid|reserved/);
    }
    expect(() => checkedEnv({ A: "x".repeat(4097) })).toThrow(/4096/);
    expect(() => checkedEnv({ A: "a\0b" })).toThrow(/NUL/);
    expect(() => checkedEnv(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`V${i}`, ""])))).toThrow(/at most 50/);
  });
});

describe("init script, hours and tags", () => {
  it("limits the init script in bytes and rejects NUL", () => {
    expect(checkedInitScript("")).toBe("");
    expect(checkedInitScript("a".repeat(8192))).toHaveLength(8192);
    expect(() => checkedInitScript("é".repeat(4097))).toThrow(/8192/);
    expect(() => checkedInitScript("a\0")).toThrow(/NUL/);
  });

  it("takes whole hours from 1 to 12", () => {
    expect(checkedMaxHours(12)).toBe(12);
    for (const h of [0, 13, 1.5, NaN]) expect(() => checkedMaxHours(h)).toThrow(/between 1 and 12/);
  });

  it("checks tag keys and values", () => {
    expect(checkedTags({ team: "x", env: "" })).toEqual({ team: "x", env: "" });
    for (const key of ["", "aws:x", "AWS:x", "iara:x", "Iara:cluster", "Name", "k".repeat(129)]) expect(() => checkedTags({ [key]: "v" })).toThrow();
    expect(() => checkedTags({ a: "v".repeat(257) })).toThrow(/256/);
    expect(() => checkedTags(Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`k${i}`, ""])))).toThrow(/at most 40/);
  });
});
