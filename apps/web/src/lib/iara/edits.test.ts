import { describe, expect, it } from "vitest";

import { applyEdits } from "./edits";

describe("applyEdits", () => {
  it("replaces each old text once, in order, on what the previous edit left", () => {
    const code = "a = 1\nb = 2\nc = a + b";
    expect(applyEdits(code, [{ old: "b = 2", new: "b = 3" }])).toBe("a = 1\nb = 3\nc = a + b");
    expect(applyEdits(code, [{ old: "a = 1", new: "a = 10" }, { old: "a = 10\nb", new: "x" }])).toBe("x = 2\nc = a + b");
  });

  it("rewrites the whole code with it as old, and writes empty code with an empty old", () => {
    expect(applyEdits("select 1", [{ old: "select 1", new: "select 2" }])).toBe("select 2");
    expect(applyEdits("  \n", [{ old: "", new: "x = 1" }])).toBe("x = 1");
  });

  it("matches CRLF line ends against the editor's LF", () => {
    expect(applyEdits("a\nb", [{ old: "a\r\nb", new: "c\r\nd" }])).toBe("c\nd");
  });

  it("refuses an old text that is missing, repeated, or empty over code", () => {
    expect(() => applyEdits("x = 1", [{ old: "y", new: "z" }])).toThrow("not found");
    expect(() => applyEdits("x\nx", [{ old: "x", new: "y" }])).toThrow("more than once");
    expect(() => applyEdits("x = 1", [{ old: "", new: "y" }])).toThrow("old is empty");
    expect(() => applyEdits("a", [{ old: "a", new: "b" }, { old: "a", new: "c" }])).toThrow("edit 2: old was not found");
  });
});
