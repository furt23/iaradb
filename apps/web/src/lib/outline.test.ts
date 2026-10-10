import type { Cell } from "@workhouse/protocol";
import { describe, expect, it } from "vitest";

import { markdownHeadings, outlineOf, type OutlineNode } from "./outline";

const md = (id: string, code: string): Cell => ({ id, kind: "markdown", code, name: "_", output: null, config: {}, setup: false });
const py = (id: string, code: string): Cell => ({ id, kind: "python", code, name: "_", output: null, config: {}, setup: false });

/** The outline as indented lines: "  1.1 Setup" is a child of "1 Intro". */
function lines(nodes: OutlineNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.number ? `${n.number} ` : ""}${n.text}`, ...lines(n.children, depth + 1)]);
}

describe("markdownHeadings", () => {
  it("finds ATX headings with their levels and lines", () => {
    expect(markdownHeadings("# One\ntext\n### Three\n")).toEqual([
      { index: 0, line: 1, level: 1, number: null, text: "One" },
      { index: 1, line: 3, level: 3, number: null, text: "Three" },
    ]);
  });

  it("drops the closing hashes, and needs a space after the hashes", () => {
    const hs = markdownHeadings("## Title ##\n#tag\n# C#\n#\n");
    expect(hs.map((h) => h.text)).toEqual(["Title", "C#", ""]);
    expect(hs.map((h) => h.line)).toEqual([1, 3, 4]);
  });

  it("ignores fenced code, with backticks or tildes", () => {
    const text = "```\n# no\n```\n~~~python\n## no\n~~~\n# yes";
    expect(markdownHeadings(text)).toEqual([{ index: 0, line: 7, level: 1, number: null, text: "yes" }]);
  });

  it("closes a fence only with a fence at least as long", () => {
    expect(markdownHeadings("````\n```\n# no\n````\n# yes").map((h) => h.text)).toEqual(["yes"]);
  });

  it("ignores indented code", () => {
    expect(markdownHeadings("    # code\n# ok").map((h) => h.text)).toEqual(["ok"]);
  });

  it("counts headings inside quotes and list items, in order", () => {
    const hs = markdownHeadings("> ## Quoted\n- # Listed\n# Top");
    expect(hs.map((h) => [h.index, h.level, h.text])).toEqual([
      [0, 2, "Quoted"],
      [1, 1, "Listed"],
      [2, 1, "Top"],
    ]);
  });

  it("reads setext headings: === is level 1, --- is level 2", () => {
    expect(markdownHeadings("Title\n=====\n\nSub\n---\n")).toEqual([
      { index: 0, line: 1, level: 1, number: null, text: "Title" },
      { index: 1, line: 4, level: 2, number: null, text: "Sub" },
    ]);
  });

  it("needs a paragraph line before a setext underline", () => {
    // "---" after a blank line is a thematic break, and after a heading it is not a setext underline
    expect(markdownHeadings("# A\n---\n\n---").map((h) => h.text)).toEqual(["A"]);
  });

  it("joins the lines of a multi-line setext heading", () => {
    expect(markdownHeadings("a\nb\n===")).toEqual([{ index: 0, line: 1, level: 1, number: null, text: "a b" }]);
  });

  it("resolves inline markers in the text", () => {
    const [a, b, c] = markdownHeadings("## **Load** the `data` from [docs](https://x.y)\n# _Notes_ and ~~old~~ *ok*\n# load_data_frame");
    expect(a.text).toBe("Load the data from docs");
    expect(b.text).toBe("Notes and old ok");
    expect(c.text).toBe("load_data_frame");
  });

  it("keeps the line numbers with CRLF line endings", () => {
    expect(markdownHeadings("# A\r\n## B").map((h) => h.line)).toEqual([1, 2]);
  });

  it("counts empty headings, so the index matches the rendering", () => {
    expect(markdownHeadings("#\n# Real").map((h) => [h.index, h.text])).toEqual([
      [0, ""],
      [1, "Real"],
    ]);
  });
});

describe("section numbers", () => {
  it("normalizes the number and takes the level from its depth", () => {
    const [h] = markdownHeadings("#### 01.02) Deep");
    expect(h).toEqual({ index: 0, line: 1, level: 2, number: "1.2", text: "Deep" });
  });

  it("reads 1, 1., 1) and 2.1.3 forms", () => {
    expect(markdownHeadings("# 1 A\n# 2. B\n# 3) C\n# 2.1.3 D").map((h) => [h.number, h.level, h.text])).toEqual([
      ["1", 1, "A"],
      ["2", 1, "B"],
      ["3", 1, "C"],
      ["2.1.3", 3, "D"],
    ]);
  });

  it("keeps a number without text as the text", () => {
    expect(markdownHeadings("# 1")[0]).toMatchObject({ number: null, text: "1" });
  });

  it("does not read a number without a space after it", () => {
    expect(markdownHeadings("# 1.Intro")[0]).toMatchObject({ number: null, text: "1.Intro" });
  });

  it("does not read a year as a section number", () => {
    expect(markdownHeadings("## 2024 Results")[0]).toMatchObject({ number: null, level: 2, text: "2024 Results" });
  });
});

describe("outlineOf", () => {
  it("nests numbered headings by their depth", () => {
    const cells = [md("a", "# 1 Intro\n## 1.1 Setup\n## 1.2 Load\n# 2 Analysis\n## 2.1 Joins\n")];
    expect(lines(outlineOf(cells))).toEqual(["1 Intro", "  1.1 Setup", "  1.2 Load", "2 Analysis", "  2.1 Joins"]);
    expect(outlineOf(cells)[0].children[1]).toMatchObject({ number: "1.2", level: 2, text: "Load" });
  });

  it("uses the number over the # count", () => {
    const tree = outlineOf([md("a", "# Top\n### 1.1 Deep\n## 2 Other\n")]);
    expect(lines(tree)).toEqual(["Top", "  1.1 Deep", "2 Other"]);
    // "###" but a level 2 section by its number
    expect(tree[0].children[0].level).toBe(2);
    // "##" but a top-level section by its number
    expect(tree[1].level).toBe(1);
  });

  it("nests mixed # levels by the nearest shallower heading", () => {
    const cells = [md("a", "# A\n## B\n### C\n## D\n# E\n#### F\n")];
    expect(lines(outlineOf(cells))).toEqual(["A", "  B", "    C", "  D", "E", "  F"]);
  });

  it("skips levels: a deeper heading still goes under the nearest shallower one", () => {
    expect(lines(outlineOf([md("a", "# A\n### C\n")]))).toEqual(["A", "  C"]);
  });

  it("ignores fenced code in the outline", () => {
    const cells = [md("a", "# Real\n```python\n# not\n```\n## Two\n")];
    expect(lines(outlineOf(cells))).toEqual(["Real", "  Two"]);
  });

  it("keeps the index of each heading within its cell", () => {
    const tree = outlineOf([md("a", "# A\n## B\n### C\n")]);
    expect(tree[0].index).toBe(0);
    expect(tree[0].children[0].index).toBe(1);
    expect(tree[0].children[0].children[0].index).toBe(2);
  });

  it("nests headings across cells and records their cell", () => {
    const tree = outlineOf([md("a", "# A\n"), md("b", "text\n## B\n")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ cellId: "a", text: "A" });
    expect(tree[0].children[0]).toMatchObject({ cellId: "b", index: 0, text: "B" });
  });

  it("ignores the headings of python and sql cells", () => {
    const cells = [py("p", "# comment\nx = 1"), md("m", "# Notes")];
    expect(outlineOf(cells)).toEqual([{ cellId: "m", index: 0, text: "Notes", level: 1, number: null, children: [] }]);
  });

  it("leaves out empty headings, but keeps the index of the others", () => {
    const tree = outlineOf([md("a", "#\n# Real\n")]);
    expect(tree).toEqual([{ cellId: "a", index: 1, text: "Real", level: 1, number: null, children: [] }]);
  });

  it("is empty for an empty notebook or one without headings", () => {
    expect(outlineOf([])).toEqual([]);
    expect(outlineOf([md("a", "just text\n\nmore text")])).toEqual([]);
  });
});
