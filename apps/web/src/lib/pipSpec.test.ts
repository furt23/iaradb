import { describe, expect, it } from "vitest";

import { pipSpecError } from "./pipSpec";

describe("pipSpecError: valid specs", () => {
  it.each([
    "polars",
    "polars==1.9",
    "scikit-learn>=1.5,<2",
    "pandas[parquet,excel]>=2.2",
    "numpy ~= 1.26",
    "torch==2.4.*",
    "requests!=2.32.0",
    "foo===1.0-custom",
    "pkg>=1.0rc1",
    "pkg==1.0.post1.dev2",
    "  polars  ",
    "pandas [parquet]",
    "a~=1.0,<2",
    "pkg==1!2.0",
    "pkg<=3.0a1",
    "pkg>1",
  ])("accepts %j", (spec) => {
    expect(pipSpecError(spec)).toBeNull();
  });
});

describe("pipSpecError: invalid specs", () => {
  it.each([
    ["polars=<>+2,1284", "unknown operator"],
    ["polars=1.9", "unknown operator"],
    ["polars==", "missing version"],
    ["==1.0", "not a package name"],
    ["polars>=1.0,", "empty version clause"],
    ["pandas[]", "empty extras"],
    ["-bad", "not a package name"],
    ["numpy~=1", "~= needs at least two version parts"],
    ["polars==1.*.2", 'bad version "1.*.2"'],
    ["git+https://x", "URLs are not supported"],
    ['polars; python_version<"3.9"', "environment markers are not supported"],
    ["a b", "unknown operator"],
    ["pandas[parquet", "missing ]"],
    ["pandas[-x]", "not a package name"],
    ["polars (>=1.0)", "parenthesized specifiers are not supported"],
    ["polars>=1.0 2", 'bad version "1.0 2"'],
    ["polars>=", "missing version"],
    ["polars>=x", 'bad version "x"'],
    ["pkg==1.0.*.post1", 'bad version "1.0.*.post1"'],
    ["pkg~=1.0.*", 'bad version "1.0.*"'],
    ["pkg>=1.0.*", 'bad version "1.0.*"'],
    ["pkg===", "missing version"],
    ["pkg===a,b", "unknown operator"],
    ["pkg==.*", 'bad version ".*"'],
    ["polars,", "empty version clause"],
    ["polars-", "not a package name"],
  ])("rejects %j with %j", (spec, message) => {
    expect(pipSpecError(spec)).toBe(message);
  });

  it("rejects empty and over-long specs", () => {
    expect(pipSpecError("")).toBe("empty");
    expect(pipSpecError("   ")).toBe("empty");
    expect(pipSpecError("a" + "1".repeat(200))).toBe("longer than 200 characters");
    expect(pipSpecError("a" + "1".repeat(199))).toBeNull();
  });
});
