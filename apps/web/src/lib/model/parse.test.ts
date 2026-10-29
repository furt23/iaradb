import { describe, expect, it } from "vitest";

import type { Expr, Stmt } from "./ast";
import { ALLOWED, parse } from "./parse";

/** parses a source that must be clean */
function statements(source: string): Stmt[] {
  const r = parse(source);
  expect(r.diagnostics).toEqual([]);
  return r.statements;
}

/** the value of `x = <source>` */
function value(source: string): Expr {
  const [s] = statements(`x = ${source}`);
  if (s.kind !== "assign") throw new Error("not an assignment");
  return s.value;
}

/** a compact S-expression of an expression, to check shapes and precedence */
function show(e: Expr): string {
  switch (e.kind) {
    case "num":
      return e.value;
    case "str":
      return JSON.stringify(e.value);
    case "const":
      return String(e.value);
    case "name":
      return e.name;
    case "attr":
      return `${show(e.object)}.${e.attr}`;
    case "call":
      return `${e.func}(${[...e.args.map(show), ...e.kwargs.map((k) => `${k.name}=${show(k.value)}`)].join(", ")})`;
    case "unary":
      return `(${e.op} ${show(e.operand)})`;
    case "binary":
      return `(${show(e.left)} ${e.op} ${show(e.right)})`;
  }
}

function messages(source: string): string[] {
  return parse(source).diagnostics.map((d) => d.message);
}

describe("literals", () => {
  it("reads ints and floats, with underscores removed and a plain SQL spelling", () => {
    expect(value("1_000")).toMatchObject({ kind: "num", value: "1000", int: true });
    expect(value("3.14")).toMatchObject({ value: "3.14", int: false });
    expect(value(".5")).toMatchObject({ value: "0.5", int: false });
    expect(value("2.")).toMatchObject({ value: "2.0", int: false });
    expect(value("1e3")).toMatchObject({ value: "1e3", int: false });
    expect(value("1_0.5_5e-2")).toMatchObject({ value: "10.55e-2" });
  });

  it("unescapes \\\\ \\' \\\" \\n \\t", () => {
    expect(value(String.raw`'a\\b\'c\"d\ne\tf'`)).toMatchObject({ value: 'a\\b\'c"d\ne\tf' });
    expect(value(String.raw`"say \"hi\""`)).toMatchObject({ value: 'say "hi"' });
    expect(value(`""`)).toMatchObject({ value: "" });
    expect(value(`'abc'`)).toMatchObject({ kind: "str", value: "abc" });
    expect(value(`'# not a comment'`)).toMatchObject({ value: "# not a comment" });
  });

  it("reads True, False and None", () => {
    expect([value("True"), value("False"), value("None")].map(show)).toEqual(["true", "false", "null"]);
  });

  it("reads names and dotted attributes", () => {
    expect(show(value("orders.total"))).toBe("orders.total");
    expect(show(value("a.b.c"))).toBe("a.b.c");
    expect(show(value("ünïcode.preço"))).toBe("ünïcode.preço");
  });
});

describe("calls", () => {
  it("reads positional then keyword arguments, and a trailing comma", () => {
    expect(show(value("f(1, a.b, k=2, z='x',)"))).toBe('f(1, a.b, k=2, z="x")');
    expect(show(value("f()"))).toBe("f()");
    expect(show(value("f(g(h(1)))"))).toBe("f(g(h(1)))");
  });

  it("joins the lines inside parentheses", () => {
    const s = statements("x = measure(\n  sum(orders.total),  # the money\n  format='currency',\n)\ny = 1");
    expect(s).toHaveLength(2);
    expect(s[1]).toMatchObject({ kind: "assign", name: "y" });
  });

  it("keeps == apart from keyword arguments", () => {
    expect(show(value("f(a == b)"))).toBe("f((a == b))");
  });
});

describe("operators", () => {
  it("binds * / % tighter than + -, and those tighter than comparisons", () => {
    expect(show(value("1 + 2 * 3"))).toBe("(1 + (2 * 3))");
    expect(show(value("a % b / c * d"))).toBe("(((a % b) / c) * d)");
    expect(show(value("a + b < c * d"))).toBe("((a + b) < (c * d))");
  });

  it("is left associative", () => {
    expect(show(value("a - b - c"))).toBe("((a - b) - c)");
  });

  it("binds unary minus tighter than * and handles stacked unaries", () => {
    expect(show(value("-a * b"))).toBe("((- a) * b)");
    expect(show(value("a * -b"))).toBe("(a * (- b))");
    expect(show(value("- -a"))).toBe("(- (- a))");
    expect(show(value("+a"))).toBe("(+ a)");
  });

  it("binds not looser than comparisons, then and, then or", () => {
    expect(show(value("not a == b"))).toBe("(not (a == b))");
    expect(show(value("a or b and c"))).toBe("(a or (b and c))");
    expect(show(value("a and not b or c"))).toBe("((a and (not b)) or c)");
    expect(show(value("not not a"))).toBe("(not (not a))");
  });

  it("reads all six comparisons", () => {
    for (const op of ["==", "!=", "<", "<=", ">", ">="]) expect(show(value(`a ${op} 1`))).toBe(`(a ${op} 1)`);
  });

  it("lets parentheses override precedence", () => {
    expect(show(value("(1 + 2) * 3"))).toBe("((1 + 2) * 3)");
    expect(show(value("(a < b) == (c < d)"))).toBe("((a < b) == (c < d))");
  });
});

describe("statements", () => {
  it("reads imports, plain and in parentheses over several lines", () => {
    expect(statements("from iara.model import measure, relate")[0]).toMatchObject({
      kind: "import",
      module: "iara.model",
      names: [{ name: "measure" }, { name: "relate" }],
    });
    const s = statements("from iara.model import (\n  measure,\n  relate,  # both\n)\nx = 1");
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ kind: "import", names: [{ name: "measure" }, { name: "relate" }] });
  });

  it("reads assignments and expression statements", () => {
    expect(statements("x = sum(a.b)\nrelate(a.b, c.d)")).toMatchObject([
      { kind: "assign", name: "x" },
      { kind: "expr", expr: { kind: "call", func: "relate" } },
    ]);
  });

  it("skips blank lines, comments and trailing comments, with LF, CRLF and no final newline", () => {
    const source = "# header\n\nx = 1  # one\r\n   # an indented comment\r\n\r\ny = 2";
    expect(statements(source).map((s) => (s.kind === "assign" ? s.name : "?"))).toEqual(["x", "y"]);
    expect(statements("")).toEqual([]);
    expect(statements("# only a comment")).toEqual([]);
    expect(statements("\ufeffx = 1")).toHaveLength(1);
  });
});

describe("refusals", () => {
  const cases: [string, string][] = [
    ["if x:\n  y = 1", "`if` is not allowed"],
    ["for i in x:\n  pass", "`for` is not allowed"],
    ["while True:\n  pass", "`while` is not allowed"],
    ["def f():\n  pass", "`def` is not allowed"],
    ["class A:\n  pass", "`class` is not allowed"],
    ["x = lambda: 1", "`lambda` is not allowed"],
    ["return 1", "`return` is not allowed"],
    ["with a as b:\n  pass", "`with` is not allowed"],
    ["try:\n  pass", "`try` is not allowed"],
    ["import os", "`import x` is not allowed"],
    ["from iara.model import *", "`import *` is not allowed"],
    ["from iara.model import a as b", "`as` is not allowed"],
    ["x = a if b else c", "`if` is not allowed: for a conditional value use `if_(condition, then, else)`"],
    ["x = a in b", "`in` is not allowed"],
    ["x = a is b", "`is` is not allowed"],
    ["x = a ** 2", "`**` is not allowed"],
    ["x = a // 2", "`//` is not allowed"],
    ["x = [1, 2]", "lists, dicts, sets and subscripts are not allowed"],
    ["x = {1: 2}", "lists, dicts, sets and subscripts are not allowed"],
    ["x = {1, 2}", "lists, dicts, sets and subscripts are not allowed"],
    ["x = a[0]", "lists, dicts, sets and subscripts are not allowed"],
    ['x = f"a{b}"', "f-strings are not allowed"],
    ["x = r'a'", "string prefixes are not allowed"],
    ["x = '''a'''", "triple-quoted strings are not allowed"],
    ['x = """a\nb"""\ny = 1', "triple-quoted strings are not allowed"],
    ["x = 1 + \\\n  2", "a backslash line continuation is not allowed"],
    ["x := 1", "`:=` is not allowed"],
    ["x += 1", "`+=` is not allowed"],
    ["x -= 1", "`-=` is not allowed"],
    ["x = y = 1", "chained assignment"],
    ["a, b = 1, 2", "tuples are not allowed"],
    ["x = (1, 2)", "tuples are not allowed"],
    ["x = 1, 2", "tuples are not allowed"],
    ["x = 1; y = 2", "`;` is not allowed"],
    ["x = a < b < c", "chained comparisons"],
    ["x = a == b != c", "chained comparisons"],
    ["f(x)(y)", "only functions can be called, by name"],
    ["a.b(1)", "only functions can be called, by name"],
    ["a.b = 1", "only a plain name can be assigned to"],
    ["1 = x", "only a plain name can be assigned to"],
    ["f(a=1, 2)", "a positional argument cannot come after a keyword argument"],
    ["f(a=1, a=2)", "the argument `a` is given twice"],
    ["f(*args)", "expected an expression, found `*`"],
    ["x: int = 1", "`:` is not allowed"],
    ["x = a & b", "`&` is not allowed: use `and`"],
    ["x = a | b", "`|` is not allowed: use `or`"],
    ["x = a <> b", "`<>` is not allowed: use `!=`"],
    ["x = a == not b", "`not` has to come before the whole comparison"],
    ["x = 0x10", "`0x10` is not a valid number"],
    ["x = 1_", "`1_` is not a valid number"],
    ["x = 1__0", "is not a valid number"],
    ["x = 5 $ 2", "unexpected character `$`"],
    ["x = 'abc", "this string is not closed"],
    ["x = 'a\\qb'", "unsupported escape `\\q`"],
    ["x = ", "expected an expression, found the end of the line"],
    ["x = (1 + ", "expected an expression, found the end of the file"],
    ["x = (1 + 2", "expected `)`"],
    ["x = f(1", "expected `,` or `)`"],
    ["x = 1 2", "expected the end of the line, found `2`"],
    ["x = a.", "expected a name after `.`"],
    ["from iara.model import", "expected a name to import"],
    ["from . import x", "expected a module name"],
    ["  x = 1", "unexpected indentation"],
    ["\tx = 1", "unexpected indentation"],
    ["x = 1\n  y = 2", "unexpected indentation"],
    ["x = 1 +", "expected an expression"],
    ["= 1", "expected an expression"],
    ["@x", "expected an expression"],
  ];

  it.each(cases)("%j says why", (source, fragment) => {
    const found = messages(source);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toContain(fragment);
  });

  it("ends the keyword messages with what is allowed", () => {
    expect(messages("def f(): pass")[0]).toContain(ALLOWED);
    expect(ALLOWED).toBe("only `name = expression` lines, `relate(...)` and `from iara.model import ...` are allowed");
  });

  it("accepts an if_ call, since the underscore makes it a plain name", () => {
    expect(show(value("if_(a, 1, 2)"))).toBe("if_(a, 1, 2)");
  });
});

describe("recovery", () => {
  it("skips only the bad line and keeps the statements around it", () => {
    const r = parse("a = 1\nb = if\nc = 3");
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].line).toBe(2);
    expect(r.statements.map((s) => s.kind)).toEqual(["assign", "invalid", "assign"]);
  });

  it("reports one error per bad line", () => {
    const r = parse("a = [1]\nb = 2 ** 3\nc = 4\nd = 'x\ne = 5");
    expect(r.diagnostics.map((d) => d.line)).toEqual([1, 2, 4]);
    expect(r.statements.filter((s) => s.kind === "assign").map((s) => (s as { name: string }).name)).toEqual(["c", "e"]);
  });

  it("skips a bad statement that spans lines inside parentheses as a whole", () => {
    const r = parse("x = f(1,\n  [2],\n  3)\ny = 4");
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].line).toBe(2);
    expect(r.statements.filter((s) => s.kind === "assign")).toHaveLength(1);
  });

  it("skips the line after a backslash continuation too", () => {
    const r = parse("x = 1 + \\\n  2\ny = 3");
    expect(r.diagnostics).toHaveLength(1);
    expect(r.statements.at(-1)).toMatchObject({ kind: "assign", name: "y" });
  });

  it("skips a triple-quoted string to its end", () => {
    const r = parse('x = """a\nb\n"""\ny = 1');
    expect(r.diagnostics).toHaveLength(1);
    expect(r.statements.at(-1)).toMatchObject({ kind: "assign", name: "y" });
  });

  it("keeps the name of a failed assignment", () => {
    expect(parse("total = sum(").statements).toMatchObject([{ kind: "invalid", name: "total" }]);
    expect(parse("if x:").statements).toMatchObject([{ kind: "invalid", name: undefined }]);
  });

  it("an unclosed parenthesis swallows the rest and says so at the end", () => {
    const r = parse("x = f(1\ny = 2");
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].message).toContain("expected");
  });

  it("never throws, whatever the text", () => {
    const junk = ["\0", "(((((", ")))", "'", '"""', "\\", "x = ", "f(", "from", "from a import (", "😀 = 1", "x = 1 \u2028 y", "\r", "..."];
    for (const j of junk) expect(() => parse(j)).not.toThrow();
    const deep = `x = ${"(".repeat(5000)}1${")".repeat(5000)}`;
    expect(parse(deep).diagnostics[0].message).toContain("nested too deeply");
    expect(parse(`x = ${"-".repeat(5000)}1`).diagnostics[0].message).toContain("nested too deeply");
    expect(parse(`x = ${"not ".repeat(5000)}1`).diagnostics[0].message).toContain("nested too deeply");
  });
});

describe("spans", () => {
  it("gives offsets and 1-based line and column of the start", () => {
    const source = "a = 1\n  # note\nrevenue = sum(orders.total)\n";
    const r = parse(source);
    const s = r.statements[1];
    if (s.kind !== "assign") throw new Error("expected an assignment");
    expect(s.span).toEqual({ from: 15, to: 42, line: 3, col: 1 });
    expect(source.slice(s.span.from, s.span.to)).toBe("revenue = sum(orders.total)");
    expect(s.nameSpan).toEqual({ from: 15, to: 22, line: 3, col: 1 });
    expect(s.value.span).toEqual({ from: 25, to: 42, line: 3, col: 11 });
    if (s.value.kind !== "call") throw new Error("expected a call");
    expect(s.value.funcSpan).toMatchObject({ from: 25, to: 28, col: 11 });
    expect(s.value.args[0].span).toMatchObject({ from: 29, to: 41, col: 15 });
  });

  it("spans a binary from its left to its right, and a parenthesized expression with its parentheses", () => {
    const e = value("(a + b) * c");
    expect(e.span).toMatchObject({ from: 4, to: 15, col: 5 });
    if (e.kind !== "binary") throw new Error("expected a binary");
    expect(e.left.span).toMatchObject({ from: 4, to: 11 });
    expect(e.right.span).toMatchObject({ from: 14, to: 15 });
  });

  it("spans keyword arguments from the name to the value", () => {
    const e = value("f(a, label='x')");
    if (e.kind !== "call") throw new Error("expected a call");
    expect(e.kwargs[0].span).toMatchObject({ from: 9, to: 18 });
  });

  it("spans an import statement and its names", () => {
    const [s] = statements("from iara.model import a, b");
    if (s.kind !== "import") throw new Error("expected an import");
    expect(s.span).toMatchObject({ from: 0, to: 27 });
    expect(s.moduleSpan).toMatchObject({ from: 5, to: 15 });
    expect(s.names[1].span).toMatchObject({ from: 26, to: 27, col: 27 });
  });

  it("puts a diagnostic on the offending token, and an end-of-line one right after the last token", () => {
    const [a] = parse("x = 1 ** 2").diagnostics;
    expect(a).toMatchObject({ from: 6, to: 8, line: 1, col: 7, severity: "error" });
    const [b] = parse("a = 1\nx = 1 +  # more\ny = 2").diagnostics;
    expect(b).toMatchObject({ from: 13, to: 13, line: 2, col: 8 });
  });

  it("counts a line break of CRLF once", () => {
    const [d] = parse("a = 1\r\nb = [2]").diagnostics;
    expect(d).toMatchObject({ line: 2, col: 5, from: 11 });
  });
});
