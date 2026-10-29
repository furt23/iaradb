/**
 * Stage 3a: checks one expression and renders it to SQL in the same walk. It
 * resolves names (datasets, columns, measures, constants), works out the level
 * of every part (see `Level`) and renders operators and literals; calls are
 * handed to the function registry.
 */

import type { Attr, Binary, Call, Expr, Name, Unary } from "./ast";
import { fail, merge, noText, type FnCx, type Typed } from "./functions/def";
import { FUNCTIONS, PLANNED } from "./functions/registry";
import { partsOf, sql, type Parts } from "./parts";
import type { ColumnRef, Measure, Relationship, Schema } from "./types";
import { quoteIdent } from "@/lib/dashboards/query";

/** What a name defined by an earlier line stands for. */
export type Entry =
  | { kind: "measure"; measure: Measure }
  | { kind: "const"; sql: string; text?: boolean }
  /** its line had an error: using it is one too */
  | { kind: "broken" };

export interface Env {
  schema: Schema;
  names: ReadonlyMap<string, Entry>;
  relationships: readonly Relationship[];
}

const ARITHMETIC = new Set(["+", "-", "*", "/", "%"]);
const SQL_OPS: Record<string, string> = { "==": "=", "!=": "<>", and: "AND", or: "OR" };

/** `x == y` and friends read as SQL; `/` is Python's true division (never whole-number division). */
function binarySql(op: string, l: Parts, r: Parts): Parts {
  if (op === "/") return sql`(CAST((${l}) AS DOUBLE) / (${r}))`;
  return sql`(${l} ${SQL_OPS[op] ?? op} ${r})`;
}

function sqlString(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

function hasDataset(env: Env, name: string): boolean {
  return Object.hasOwn(env.schema, name);
}

const datasetList = (env: Env) => Object.keys(env.schema).join(", ") || "none";

/** Resolves a bare name to a defined entry or "dataset"; anything else is the right error. */
function resolve(node: Name, env: Env): Exclude<Entry, { kind: "broken" }> | "dataset" {
  const { name } = node;
  const entry = env.names.get(name);
  if (entry?.kind === "broken") fail(node, `\`${name}\` has an error`);
  if (entry) return entry;
  if (hasDataset(env, name)) return "dataset";
  if (PLANNED.has(name)) fail(node, `${name} is not available yet`);
  if (FUNCTIONS.has(name)) fail(node, `\`${name}\` is a function: call it, e.g. ${name}(...)`);
  return fail(node, `unknown name ${name}`);
}

function column(node: Expr, env: Env): ColumnRef {
  if (node.kind !== "attr" || node.object.kind !== "name") fail(node, "expected a column written dataset.column, e.g. orders.total");
  const owner = resolve(node.object, env);
  if (owner !== "dataset") fail(node.object, `\`${node.object.name}\` is not a dataset (datasets: ${datasetList(env)})`);
  const known = env.schema[node.object.name];
  if (known && !known.includes(node.attr)) fail(node, `${node.object.name} has no column ${node.attr}`);
  return { dataset: node.object.name, column: node.attr };
}

function checkAttr(node: Attr, env: Env): Typed {
  const { dataset, column: col } = column(node, env);
  return { level: "row", sql: [quoteIdent(col)], datasets: [dataset], bare: { text: `${dataset}.${col}`, span: node.span } };
}

function checkName(node: Name, env: Env): Typed {
  const r = resolve(node, env);
  if (r === "dataset") {
    return fail(node, `\`${node.name}\` is a dataset, not a value: use ${node.name}.column or count_rows(${node.name})`);
  }
  // a measure used by name brings its aggregations along, in parentheses
  if (r.kind === "measure") return { level: "aggregate", sql: sql`(${partsOf(r.measure)})`, datasets: r.measure.datasets };
  return { level: "scalar", sql: [r.sql], datasets: [], text: r.text };
}

function checkUnary(node: Unary, cx: FnCx): Typed {
  const x = cx.expr(node.operand);
  if (node.op !== "not") noText(node.operand, x);
  const value = node.op === "-" ? sql`(-${x.sql})` : node.op === "not" ? sql`(NOT ${x.sql})` : x.sql;
  return { ...merge([{ node: node.operand, typed: x }]), sql: value };
}

function checkBinary(node: Binary, cx: FnCx): Typed {
  const l = cx.expr(node.left);
  const r = cx.expr(node.right);
  if (ARITHMETIC.has(node.op)) {
    noText(node.left, l);
    noText(node.right, r);
  }
  return { ...merge([{ node: node.left, typed: l }, { node: node.right, typed: r }]), sql: binarySql(node.op, l.sql, r.sql) };
}

function checkCall(node: Call, cx: FnCx, wholeValue: boolean): Typed {
  const def = FUNCTIONS.get(node.func);
  if (!def) return fail({ span: node.funcSpan }, PLANNED.has(node.func) ? `${node.func} is not available yet` : `unknown function ${node.func}`);
  if (def.kind === "statement") fail(node, `${node.func}(...) has to be a line of its own`);
  if (def.kind === "assignment" && !wholeValue) fail(node, `${node.func}(...) has to be the whole value of a line: name = ${node.func}(...)`);
  return def.check(node, cx);
}

/** What functions get to call back into the checker. */
export function exprContext(env: Env): FnCx & { walk(node: Expr, wholeValue: boolean): Typed } {
  const cx: FnCx & { walk(node: Expr, wholeValue: boolean): Typed } = {
    walk(node, wholeValue) {
      switch (node.kind) {
        case "num":
          return { level: "scalar", sql: [node.value], datasets: [] };
        case "str":
          return { level: "scalar", sql: [sqlString(node.value)], datasets: [], text: true };
        case "const":
          return { level: "scalar", sql: [node.value === null ? "NULL" : node.value ? "TRUE" : "FALSE"], datasets: [] };
        case "name":
          return checkName(node, env);
        case "attr":
          return checkAttr(node, env);
        case "call":
          return checkCall(node, cx, wholeValue);
        case "unary":
          return checkUnary(node, cx);
        case "binary":
          return checkBinary(node, cx);
      }
    },
    expr: (node) => cx.walk(node, false),
    column: (node) => column(node, env),
    dataset(node) {
      if (node.kind === "name" && resolve(node, env) === "dataset") return node.name;
      return fail(node, `expected a dataset name (datasets: ${datasetList(env)})`);
    },
    relationships: env.relationships,
  };
  return cx;
}

/**
 * Checks `node`. `wholeValue`: it is the entire right-hand side of an
 * assignment, where `measure(...)` is allowed.
 */
export function checkExpr(node: Expr, env: Env, wholeValue = false): Typed {
  return exprContext(env).walk(node, wholeValue);
}
