import { describe, expect, it } from "vitest";

import { lex, locator } from "./lex";

/** `kind:text` of every token, to compare at a glance */
const shape = (source: string) => lex(source).map((t) => `${t.kind}:${t.kind === "error" ? t.value : t.text}`);

describe("lex", () => {
  it("ends with a newline and an eof, and has no newline for blank or comment-only lines", () => {
    expect(shape("a\n\n# c\n\nb")).toEqual(["name:a", "newline:\n", "name:b", "newline:", "eof:"]);
    expect(shape("")).toEqual(["eof:"]);
    expect(shape("# only")).toEqual(["eof:"]);
  });

  it("joins the lines inside brackets, not outside", () => {
    expect(shape("f(a,\n  b)\nc")).toEqual(["name:f", "op:(", "name:a", "op:,", "name:b", "op:)", "newline:\n", "name:c", "newline:", "eof:"]);
    expect(shape("f(a]\nb")).toContain("newline:\n");
  });

  it("reads the longest operator", () => {
    expect(shape("a **= b == c // d")).toEqual(["name:a", "op:**=", "name:b", "op:==", "name:c", "op://", "name:d", "newline:", "eof:"]);
  });

  it("normalizes numbers", () => {
    const [n] = lex("1_000.50");
    expect(n).toMatchObject({ kind: "num", value: "1000.50", int: false, from: 0, to: 8 });
  });

  it("turns problems into error tokens and goes on", () => {
    expect(shape("'abc\nb")).toEqual(["error:this string is not closed: strings are written '...' or \"...\" on one line", "newline:\n", "name:b", "newline:", "eof:"]);
    expect(lex("  a")[0]).toMatchObject({ kind: "error", from: 0, to: 2 });
    expect(shape("a $")).toContain("error:unexpected character `$`");
    expect(shape("\\")).toContain("error:unexpected character `\\`");
  });

  it("flags only the indentation of a statement start, not of a continuation line", () => {
    expect(shape("f(\n    a)")).not.toContainEqual(expect.stringContaining("indentation"));
    expect(shape("a\n  b")).toContainEqual(expect.stringContaining("indentation"));
  });

  it("reads an emoji as one character", () => {
    expect(lex("😀")[0]).toMatchObject({ kind: "error", from: 0, to: 2 });
  });
});

describe("locator", () => {
  it("gives 1-based line and column", () => {
    const at = locator("ab\ncd\r\nef");
    expect(at(0)).toMatchObject({ line: 1, col: 1 });
    expect(at(2)).toMatchObject({ line: 1, col: 3 });
    expect(at(3)).toMatchObject({ line: 2, col: 1 });
    expect(at(7)).toMatchObject({ line: 3, col: 1 });
    expect(at(8)).toMatchObject({ from: 8, to: 8, line: 3, col: 2 });
  });
});
