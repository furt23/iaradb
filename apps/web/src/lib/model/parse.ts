/**
 * Stage 2: tokens to a tree. This is a parser for a small subset of Python
 * (see ast.ts); the source is never run. It never throws: a bad line becomes a
 * diagnostic, the parser skips to the next top-level newline and carries on, so
 * one typo does not hide the errors (or the measures) of the other lines.
 */

import type { AssignStmt, BinaryOp, Call, Expr, ImportStmt, Kwarg, Stmt } from "./ast";
import { KEYWORDS, lex, locator, type Token } from "./lex";
import type { Diagnostic, Span } from "./types";

/** what a line of the file may be; the end of most messages about Python that is not allowed */
export const ALLOWED = "only `name = expression` lines, `relate(...)` and `from iara.model import ...` are allowed";

export interface ParseResult {
  statements: Stmt[];
  diagnostics: Diagnostic[];
}

const MAX_NESTING = 100;
const COMPARE = new Set(["==", "!=", "<", "<=", ">", ">="]);

const OP_MESSAGES: Record<string, string> = {
  "[": "lists, dicts, sets and subscripts are not allowed",
  "]": "lists, dicts, sets and subscripts are not allowed",
  "{": "lists, dicts, sets and subscripts are not allowed",
  "}": "lists, dicts, sets and subscripts are not allowed",
  ":": "`:` is not allowed: there are no blocks, annotations or slices",
  ";": "`;` is not allowed: put each statement on its own line",
  ",": "tuples are not allowed: a comma only separates the arguments of a call",
  "**": "`**` is not allowed: there is no power operator",
  "//": "`//` is not allowed: `/` is the only division",
  ":=": "`:=` is not allowed: write `name = expression`",
  "&": "`&` is not allowed: use `and`",
  "|": "`|` is not allowed: use `or`",
  "!": "`!` is not allowed: use `not`, or `!=` to compare",
  "<>": "`<>` is not allowed: use `!=`",
};
for (const op of ["+=", "-=", "*=", "/=", "%=", "**=", "//=", "&=", "|=", "^=", "@=", "<<=", ">>="]) {
  OP_MESSAGES[op] = `\`${op}\` is not allowed: ${ALLOWED}`;
}

const KEYWORD_TIPS: Record<string, string> = {
  if: "for a conditional value use `if_(condition, then, else)`",
  elif: "for a conditional value use `if_(condition, then, else)`",
  else: "for a conditional value use `if_(condition, then, else)`",
  in: "compare with ==, !=, <, <=, > and >=",
  is: "compare with ==, !=, <, <=, > and >=",
  lambda: "functions cannot be defined",
  def: "functions cannot be defined",
  as: "names are imported as they are",
};

/** Internal: aborts the line being parsed. */
class ParseError extends Error {
  constructor(
    readonly from: number,
    readonly to: number,
    message: string,
  ) {
    super(message);
  }
}

class Parser {
  private pos = 0;
  private lastEnd = 0;
  private depth = 0;
  readonly at: (offset: number) => Span;

  constructor(
    source: string,
    private readonly toks: Token[],
  ) {
    this.at = locator(source);
  }

  // ---- token helpers

  get index() {
    return this.pos;
  }
  peek(ahead = 0): Token {
    return this.toks[Math.min(this.pos + ahead, this.toks.length - 1)];
  }
  atEof() {
    return this.peek().kind === "eof";
  }
  private next(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.pos++;
    this.lastEnd = t.to;
    return t;
  }
  private isOp(text: string, ahead = 0) {
    const t = this.peek(ahead);
    return t.kind === "op" && t.text === text;
  }
  private isWord(text: string) {
    const t = this.peek();
    return t.kind === "name" && t.text === text;
  }

  private span(from: number, to: number): Span {
    return { ...this.at(from), to };
  }
  private tokSpan(t: Token): Span {
    return this.span(t.from, t.to);
  }
  private fromTo(start: Span, end: number): Span {
    return { ...start, to: end };
  }

  private describe(t: Token): string {
    if (t.kind === "eof") return "the end of the file";
    if (t.kind === "newline") return "the end of the line";
    return `\`${t.text.length > 20 ? `${t.text.slice(0, 20)}...` : t.text}\``;
  }

  /** Aborts the line with `message` at token `t` (the line end for a newline or the file end). */
  private fail(t: { from: number; to: number; kind?: string }, message: string): never {
    const atEnd = t.kind === "newline" || t.kind === "eof";
    throw new ParseError(atEnd ? this.lastEnd : t.from, atEnd ? this.lastEnd : t.to, message);
  }
  private failAt(node: { span: Span }, message: string): never {
    throw new ParseError(node.span.from, node.span.to, message);
  }

  /** The error for a token that is in the way: its own message when it has one, else `expected ...`. */
  private unexpected(t: Token, expecting: string): never {
    if (t.kind === "error") this.fail(t, t.value);
    if (t.kind === "name" && KEYWORDS.has(t.text) && !["True", "False", "None"].includes(t.text)) this.fail(t, this.keywordMessage(t.text));
    if (t.kind === "op" && OP_MESSAGES[t.text]) this.fail(t, OP_MESSAGES[t.text]);
    this.fail(t, `expected ${expecting}, found ${this.describe(t)}`);
  }

  private keywordMessage(word: string): string {
    const tip = KEYWORD_TIPS[word];
    return `\`${word}\` is not allowed: ${tip ? `${tip}; ` : ""}${ALLOWED}`;
  }

  private expectOp(text: string, expecting = `\`${text}\``): Token {
    if (!this.isOp(text)) this.unexpected(this.peek(), expecting);
    return this.next();
  }

  private nesting<T>(f: () => T): T {
    if (++this.depth > MAX_NESTING) this.fail(this.peek(), "this expression is nested too deeply");
    try {
      return f();
    } finally {
      this.depth--;
    }
  }

  // ---- recovery

  /** Skips the rest of the line that failed, up to and including its newline. */
  skipLine() {
    while (this.peek().kind !== "newline" && !this.atEof()) this.next();
    if (this.peek().kind === "newline") this.next();
  }
  skipNewlines() {
    while (this.peek().kind === "newline") this.next();
  }

  // ---- statements

  statement(): Stmt {
    const first = this.peek();
    if (first.kind === "name" && first.text === "from") return this.fromImport();
    if (first.kind === "name" && first.text === "import") {
      this.fail(first, "`import x` is not allowed: use `from iara.model import ...` (it is optional, every function and dataset is always available)");
    }
    const expr = this.expression();
    if (this.isOp("=")) {
      if (expr.kind !== "name") this.failAt(expr, "only a plain name can be assigned to, e.g. `revenue = sum(orders.total)`");
      this.next();
      const value = this.expression();
      if (this.isOp("=")) this.fail(this.peek(), "chained assignment (`a = b = 1`) is not allowed: write one `name = expression` per line");
      this.endOfStatement();
      const stmt: AssignStmt = { kind: "assign", name: expr.name, nameSpan: expr.span, value, span: this.fromTo(expr.span, this.lastEnd) };
      return stmt;
    }
    this.endOfStatement();
    return { kind: "expr", expr, span: expr.span };
  }

  private endOfStatement() {
    const t = this.peek();
    if (t.kind !== "newline" && t.kind !== "eof") this.unexpected(t, "the end of the line");
  }

  private dottedName(): { text: string; span: Span } {
    const start = this.peek();
    let end = start.to;
    let text = this.word("a module name").text;
    while (this.isOp(".")) {
      this.next();
      const part = this.word("a name after `.`");
      text += `.${part.text}`;
      end = part.to;
    }
    return { text, span: this.span(start.from, end) };
  }

  /** A name that is not a Python keyword. */
  private word(expecting: string): Token {
    const t = this.peek();
    if (t.kind !== "name" || KEYWORDS.has(t.text)) this.unexpected(t, expecting);
    return this.next();
  }

  private fromImport(): ImportStmt {
    const start = this.next();
    const module = this.dottedName();
    if (!this.isWord("import")) this.unexpected(this.peek(), "`import`");
    this.next();
    const paren = this.isOp("(");
    if (paren) this.next();
    const names: ImportStmt["names"] = [];
    for (;;) {
      if (this.isOp("*")) this.fail(this.peek(), "`import *` is not allowed: name what you import, or leave the import out");
      const t = this.word("a name to import");
      names.push({ name: t.text, span: this.tokSpan(t) });
      if (this.isWord("as")) this.fail(this.peek(), this.keywordMessage("as"));
      if (!this.isOp(",")) break;
      this.next();
      if (paren && this.isOp(")")) break;
    }
    if (paren) this.expectOp(")", "`,` or `)`");
    this.endOfStatement();
    return { kind: "import", module: module.text, moduleSpan: module.span, names, span: this.span(start.from, this.lastEnd) };
  }

  // ---- expressions, loosest binding first

  expression(): Expr {
    return this.nesting(() => this.or());
  }

  private or(): Expr {
    let left = this.and();
    while (this.isWord("or")) {
      this.next();
      left = this.binary("or", left, this.and());
    }
    return left;
  }

  private and(): Expr {
    let left = this.not();
    while (this.isWord("and")) {
      this.next();
      left = this.binary("and", left, this.not());
    }
    return left;
  }

  private not(): Expr {
    if (!this.isWord("not")) return this.comparison();
    const op = this.next();
    return this.nesting(() => {
      const operand = this.not();
      return { kind: "unary", op: "not", operand, span: this.fromTo(this.tokSpan(op), operand.span.to) };
    });
  }

  private comparison(): Expr {
    const left = this.additive();
    const t = this.peek();
    if (t.kind !== "op" || !COMPARE.has(t.text)) return left;
    this.next();
    const result = this.binary(t.text as BinaryOp, left, this.additive());
    const again = this.peek();
    if (again.kind === "op" && COMPARE.has(again.text)) {
      this.fail(again, "chained comparisons (`a < b < c`) are not allowed: write `a < b and b < c`");
    }
    return result;
  }

  private additive(): Expr {
    let left = this.term();
    for (let t = this.peek(); t.kind === "op" && (t.text === "+" || t.text === "-"); t = this.peek()) {
      this.next();
      left = this.binary(t.text as BinaryOp, left, this.term());
    }
    return left;
  }

  private term(): Expr {
    let left = this.unary();
    for (let t = this.peek(); t.kind === "op" && (t.text === "*" || t.text === "/" || t.text === "%"); t = this.peek()) {
      this.next();
      left = this.binary(t.text as BinaryOp, left, this.unary());
    }
    return left;
  }

  private unary(): Expr {
    const t = this.peek();
    if (t.kind !== "op" || (t.text !== "-" && t.text !== "+")) return this.postfix();
    this.next();
    return this.nesting(() => {
      const operand = this.unary();
      return { kind: "unary", op: t.text as "-" | "+", operand, span: this.fromTo(this.tokSpan(t), operand.span.to) };
    });
  }

  private binary(op: BinaryOp, left: Expr, right: Expr): Expr {
    return { kind: "binary", op, left, right, span: this.fromTo(left.span, right.span.to) };
  }

  private postfix(): Expr {
    let e = this.atom();
    for (;;) {
      if (this.isOp("(")) {
        e = this.call(e);
      } else if (this.isOp(".")) {
        this.next();
        const attr = this.word("a name after `.`");
        e = { kind: "attr", object: e, attr: attr.text, span: this.fromTo(e.span, attr.to) };
      } else {
        return e;
      }
    }
  }

  private call(callee: Expr): Call {
    if (callee.kind !== "name") this.failAt(callee, "only functions can be called, by name: e.g. `sum(orders.total)`");
    this.next();
    const args: Expr[] = [];
    const kwargs: Kwarg[] = [];
    while (!this.isOp(")")) {
      const t = this.peek();
      if (t.kind === "name" && !KEYWORDS.has(t.text) && this.isOp("=", 1)) {
        this.next();
        this.next();
        const value = this.expression();
        if (kwargs.some((k) => k.name === t.text)) this.fail(t, `the argument \`${t.text}\` is given twice`);
        kwargs.push({ name: t.text, value, span: this.fromTo(this.tokSpan(t), value.span.to) });
      } else {
        const value = this.expression();
        if (kwargs.length > 0) this.failAt(value, "a positional argument cannot come after a keyword argument (name=value)");
        args.push(value);
      }
      if (this.isOp(",")) this.next();
      else if (!this.isOp(")")) this.unexpected(this.peek(), "`,` or `)`");
    }
    const close = this.next();
    return { kind: "call", func: callee.name, funcSpan: callee.span, args, kwargs, span: this.fromTo(callee.span, close.to) };
  }

  private atom(): Expr {
    const t = this.peek();
    const span = this.tokSpan(t);
    switch (t.kind) {
      case "num":
        this.next();
        return { kind: "num", value: t.value, int: t.int === true, span };
      case "str":
        this.next();
        return { kind: "str", value: t.value, span };
      case "name": {
        if (t.text === "True" || t.text === "False" || t.text === "None") {
          this.next();
          return { kind: "const", value: t.text === "None" ? null : t.text === "True", span };
        }
        if (t.text === "not") this.fail(t, "`not` has to come before the whole comparison: wrap it in parentheses to use it here, e.g. (not x)");
        if (KEYWORDS.has(t.text)) this.fail(t, this.keywordMessage(t.text));
        this.next();
        return { kind: "name", name: t.text, span };
      }
      default:
        if (t.kind === "op" && t.text === "(") return this.parenthesized();
        return this.unexpected(t, "an expression");
    }
  }

  private parenthesized(): Expr {
    const open = this.next();
    const inner = this.expression();
    if (this.isOp(",")) this.fail(this.peek(), OP_MESSAGES[","]);
    const close = this.expectOp(")");
    // widened to the parentheses, so an error under them is underlined whole
    return { ...inner, span: this.span(open.from, close.to) };
  }
}

/** Reads `source` into statements. Never throws. */
export function parse(source: string): ParseResult {
  const toks = lex(source);
  const p = new Parser(source, toks);
  const statements: Stmt[] = [];
  const diagnostics: Diagnostic[] = [];

  for (;;) {
    p.skipNewlines();
    if (p.atEof()) break;
    const start = p.index;
    try {
      statements.push(p.statement());
    } catch (e) {
      const first = toks[start];
      const [from, to] = e instanceof ParseError ? [e.from, e.to] : [first.from, first.to];
      const message = e instanceof ParseError ? e.message : `this line could not be read (${e instanceof Error ? e.message : String(e)})`;
      diagnostics.push({ ...p.at(from), to, severity: "error", message });
      const isAssign = first.kind === "name" && !KEYWORDS.has(first.text) && toks[start + 1]?.kind === "op" && toks[start + 1].text === "=";
      p.skipLine();
      statements.push({ kind: "invalid", name: isAssign ? first.text : undefined, span: { ...p.at(first.from), to: Math.max(to, first.to) } });
    }
  }
  return { statements, diagnostics };
}
