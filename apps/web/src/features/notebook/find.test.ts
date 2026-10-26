import type { Cell } from "@iara/protocol";
import { describe, expect, it } from "vitest";

import { findMatches, findRegExp, replaceAll, replaceAt, type FindOptions } from "./find";

const cell = (id: string, code: string): Cell => ({ id, kind: "python", code, name: "_", output: null, config: {}, setup: false });
const opts = (text: string, rest: Partial<FindOptions> = {}): FindOptions => ({ text, matchCase: false, regex: false, word: false, ...rest });

describe("notebook find", () => {
  it("takes the text literally unless it is a regular expression", () => {
    const cells = [cell("a", "x = df.col(1)\nDF.col(2)"), cell("b", "dfXcol")];
    expect(findMatches(cells, findRegExp(opts("df.col(")))).toEqual([
      { cellId: "a", index: 4, length: 7 },
      { cellId: "a", index: 14, length: 7 },
    ]);
    expect(findMatches(cells, findRegExp(opts("df.col", { regex: true }))).map((m) => m.cellId)).toEqual(["a", "a", "b"]);
  });

  it("matches case and whole words on request", () => {
    const cells = [cell("a", "Total total subtotal")];
    expect(findMatches(cells, findRegExp(opts("total", { matchCase: true })))).toHaveLength(2);
    expect(findMatches(cells, findRegExp(opts("total", { word: true })))).toHaveLength(2);
    expect(findMatches(cells, findRegExp(opts("total", { word: true, matchCase: true })))).toHaveLength(1);
  });

  it("finds nothing for an empty or invalid search, and skips empty matches", () => {
    const cells = [cell("a", "abc")];
    expect(findRegExp(opts(""))).toBeNull();
    expect(findRegExp(opts("(", { regex: true }))).toBeNull();
    expect(findMatches(cells, findRegExp(opts("x*", { regex: true })))).toEqual([]);
  });

  it("replaces one match, with $1 in a regular expression and literally otherwise", () => {
    const code = "a1 a2";
    expect(replaceAt(code, 3, opts("a(\\d)", { regex: true }), "b$1")).toBe("a1 b2");
    expect(replaceAt(code, 0, opts("a1"), "$&!")).toBe("$&! a2");
  });

  it("replaces every match of every cell that has one", () => {
    const cells = [cell("a", "foo foo\nfoo"), cell("b", "bar"), cell("c", "a foo")];
    const out = replaceAll(cells, opts("foo"), "quux");
    expect([...out]).toEqual([
      ["a", "quux quux\nquux"],
      ["c", "a quux"],
    ]);
  });
});
