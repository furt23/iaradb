/**
 * The tree `parse` builds from model.py: the small subset of Python the model
 * language allows. Every node carries its `Span` so errors point at the source.
 */

import type { Span } from "./types";

export interface Num {
  kind: "num";
  /** digits as SQL writes them: underscores removed, `.5` as `0.5`, `1.` as `1.0` */
  value: string;
  /** written without a dot or an exponent */
  int: boolean;
  span: Span;
}

export interface Str {
  kind: "str";
  /** unescaped */
  value: string;
  span: Span;
}

/** `True`, `False`, `None` */
export interface Const {
  kind: "const";
  value: boolean | null;
  span: Span;
}

export interface Name {
  kind: "name";
  name: string;
  span: Span;
}

/** `object.attr`, used for `dataset.column` */
export interface Attr {
  kind: "attr";
  object: Expr;
  attr: string;
  span: Span;
}

/** `name=value` inside a call */
export interface Kwarg {
  name: string;
  value: Expr;
  span: Span;
}

/** only functions called by name are allowed, so the callee is a plain string */
export interface Call {
  kind: "call";
  func: string;
  funcSpan: Span;
  args: Expr[];
  kwargs: Kwarg[];
  span: Span;
}

export interface Unary {
  kind: "unary";
  op: "-" | "+" | "not";
  operand: Expr;
  span: Span;
}

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";

export interface Binary {
  kind: "binary";
  op: BinaryOp;
  left: Expr;
  right: Expr;
  span: Span;
}

export type Expr = Num | Str | Const | Name | Attr | Call | Unary | Binary;

/** The `dataset.column` nodes inside an expression, in order of appearance (what a calculate filter reads). */
export function attrs(e: Expr): Attr[] {
  switch (e.kind) {
    case "attr":
      return [e];
    case "unary":
      return attrs(e.operand);
    case "binary":
      return [...attrs(e.left), ...attrs(e.right)];
    case "call":
      return [...e.args, ...e.kwargs.map((k) => k.value)].flatMap(attrs);
    default:
      return [];
  }
}

/** `from iara.model import a, b` */
export interface ImportStmt {
  kind: "import";
  module: string;
  moduleSpan: Span;
  names: { name: string; span: Span }[];
  span: Span;
}

/** `name = expression` */
export interface AssignStmt {
  kind: "assign";
  name: string;
  nameSpan: Span;
  value: Expr;
  span: Span;
}

export interface ExprStmt {
  kind: "expr";
  expr: Expr;
  span: Span;
}

/**
 * A line that did not parse. When it began like `name = ...` the name is kept,
 * so later lines that use it hear "has an error" instead of "unknown name".
 */
export interface InvalidStmt {
  kind: "invalid";
  name?: string;
  span: Span;
}

export type Stmt = ImportStmt | AssignStmt | ExprStmt | InvalidStmt;
