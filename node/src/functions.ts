import { JsExpr } from "../native/index.js";
import {
  column,
  Expr,
  flatten,
  toColumnExpr,
  toExpr,
  type Nested,
  type Operand,
} from "./expr.js";

export { struct } from "./struct.js";

/** A column by name; several names give one expression each. */
export function col(name: string): Expr;
export function col(name: string, ...more: string[]): Expr[];
export function col(name: string, ...more: string[]): Expr | Expr[] {
  if (more.length === 0) return column(name);
  return [name, ...more].map(column);
}

/** Every column, for select and count-like calls. */
export function all(): Expr {
  return new Expr(JsExpr.wildcard());
}

/** A literal value (a plain object is a struct literal). */
export function lit(value: Operand | Record<string, Operand>): Expr {
  return toExpr(value);
}

/** Number of rows where `condition` is true; 0 for a group with none (Polars). */
export function countIf(condition: Operand): Expr {
  return new Expr(JsExpr.func("coalesce", [toExpr(condition)._e.agg("count_if"), JsExpr.lit(0)]));
}

/** The current timestamp (UTC, no time zone): one value for the whole query. */
export function now(): Expr {
  return new Expr(JsExpr.func("now", []));
}

/** The constant pi. */
export function pi(): Expr {
  return new Expr(JsExpr.func("pi", []));
}

/**
 * Uniform random floats in [0, 1), one per row. No seed: different on every
 * run. With `seed`: reproducible when batches run in order. With `seed` and
 * `key` (an integer column): a pure function of (seed, key).
 */
export function rand(options: { seed?: number; key?: Operand } = {}): Expr {
  const { seed, key } = options;
  if (seed === undefined) {
    if (key !== undefined) throw new Error("`key` needs a `seed`");
    return new Expr(JsExpr.func("random", []));
  }
  const args = [JsExpr.lit(seed)];
  if (key !== undefined && key !== null) args.push(toExpr(key)._e);
  return new Expr(JsExpr.func("random", args));
}

/** count(*): the number of rows. */
export function count(): Expr {
  return new Expr(JsExpr.countStar().alias("count"));
}

/** len(*): the number of rows (alias `len`). */
export function len(): Expr {
  return new Expr(JsExpr.countStar().alias("len"));
}

/** Sum of a column. */
export function sum(name: Operand): Expr {
  return toColumnExpr(name).sum();
}

/** Mean of a column. */
export function mean(name: Operand): Expr {
  return toColumnExpr(name).mean();
}

/** Smallest value of a column. */
export function min(name: Operand): Expr {
  return toColumnExpr(name).min();
}

/** Largest value of a column. */
export function max(name: Operand): Expr {
  return toColumnExpr(name).max();
}

/** 1-based row position (per group with `.over(...)`). */
export function rowNumber(): Expr {
  return new Expr(JsExpr.window("row_number", []));
}

/** The first non-null of the expressions. */
export function coalesce(...exprs: Nested<Operand>[]): Expr {
  return new Expr(JsExpr.func("coalesce", flatten(exprs).map((e) => toColumnExpr(e)._e)));
}

/** The largest of the expressions in each row. */
export function greatest(...exprs: Nested<Operand>[]): Expr {
  return new Expr(JsExpr.func("greatest", flatten(exprs).map((e) => toColumnExpr(e)._e)));
}

/** The smallest of the expressions in each row. */
export function least(...exprs: Nested<Operand>[]): Expr {
  return new Expr(JsExpr.func("least", flatten(exprs).map((e) => toColumnExpr(e)._e)));
}

/** Joins lists (and plain values, as one-element lists) into one list per row; a null list makes the result null. */
export function concatList(...exprs: Nested<Operand>[]): Expr {
  return new Expr(JsExpr.func("concat_list", flatten(exprs).map((e) => toColumnExpr(e)._e)));
}

/** Concatenates text values in each row, with `separator` between them. */
export function concatStr(exprs: Nested<Operand>, options: { separator?: string } = {}): Expr {
  const items = flatten([exprs]).map((e) => toColumnExpr(e));
  const args: JsExpr[] = [];
  items.forEach((e, i) => {
    if (i > 0 && options.separator) args.push(JsExpr.lit(options.separator));
    args.push(e._e);
  });
  return new Expr(JsExpr.func("concat", args));
}

/** The branch of `when(cond).then(a).when(cond2).then(b).otherwise(c)`. */
export class When {
  private readonly branches: ReadonlyArray<readonly [JsExpr, JsExpr]>;
  private readonly cond: JsExpr;

  constructor(branches: ReadonlyArray<readonly [JsExpr, JsExpr]>, cond: JsExpr) {
    this.branches = branches;
    this.cond = cond;
  }

  /** The value for the rows matching this condition. */
  then(value: Operand): Then {
    return new Then([...this.branches, [this.cond, toExpr(value)._e]]);
  }
}

/** A `when ... then` chain; usable as an expression before `otherwise`. */
export class Then extends Expr {
  private readonly branches: ReadonlyArray<readonly [JsExpr, JsExpr]>;

  constructor(branches: ReadonlyArray<readonly [JsExpr, JsExpr]>) {
    super(JsExpr.case(branches.map((b) => b[0]), branches.map((b) => b[1])));
    this.branches = branches;
  }

  /** Another condition; its `then` value applies where the earlier ones do not hold. */
  when(condition: Operand): When {
    return new When(this.branches, toExpr(condition)._e);
  }

  /** The value where no condition holds. */
  otherwise(value: Operand): Expr {
    return new Expr(JsExpr.case(this.branches.map((b) => b[0]), this.branches.map((b) => b[1]), toExpr(value)._e));
  }
}

/** Starts a conditional: `when(cond).then(a).otherwise(b)`. */
export function when(condition: Operand): When {
  return new When([], toExpr(condition)._e);
}
