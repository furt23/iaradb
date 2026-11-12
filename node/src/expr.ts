import { JsExpr } from "../native/index.js";
import { DtNamespace } from "./dt.js";
import { ListNamespace } from "./list.js";
import { StrNamespace } from "./str.js";
import { StructNamespace, StructUnnest, struct } from "./struct.js";
import {
  cumulativeExpr,
  diffExpr,
  overExpr,
  rankExpr,
  rollingExpr,
  shiftExpr,
  type OverOptions,
  type RankMethod,
  type RollingOptions,
} from "./window.js";

/** A value that is a literal wherever an expression is expected (strings included). */
export type Scalar = number | bigint | boolean | string | null | Date | Uint8Array;
/** An expression or a literal value. */
export type Operand = Expr | Scalar;
/** A dictionary of named expressions, the trailing argument of select-like calls. */
export type Named = Record<string, Operand>;
/** A value, a list of values, or nested lists of them. */
export type Nested<T> = T | readonly Nested<T>[];
/** One argument of select-like calls: an expression, a literal, a struct unnest, or named expressions. */
export type SelectItem = Nested<Operand | Named | StructUnnest>;

export function isPlainObject(x: unknown): x is Named {
  if (typeof x !== "object" || x === null) return false;
  const proto: unknown = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

/** Flattens the list arguments of a call, so `f(["a", "b"], "c")` sees three items. */
export function flatten<T>(items: readonly Nested<T>[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (Array.isArray(item)) out.push(...flatten<T>(item as readonly Nested<T>[]));
    else out.push(item as T);
  }
  return out;
}

/** A per-key flag list: one flag for every key, or the list given. */
export function perKey(flag: boolean | readonly boolean[], n: number): boolean[] {
  return typeof flag === "boolean" ? new Array<boolean>(n).fill(flag) : [...flag];
}

/** Wraps a value as an expression: expressions pass through, plain objects become structs, the rest literals. */
export function toExpr(value: Operand | Named): Expr {
  if (value instanceof Expr) return value;
  if (isPlainObject(value)) return struct(value);
  return new Expr(JsExpr.lit(value));
}

/** A column reference by name ("*" is every column); other values go through `toExpr`. */
export function toColumnExpr(value: Operand): Expr {
  if (typeof value === "string") return column(value);
  return toExpr(value);
}

/** A column by name ("*": all of them). */
export function column(name: string): Expr {
  return name === "*" ? new Expr(JsExpr.wildcard()) : new Expr(JsExpr.col(name));
}

/** An unaliased expression takes its root column name, as in select(col("a") + 1). */
export function namedExpr(e: Expr): JsExpr {
  const native = e._e;
  if (native.isAlias() || native.isColumn()) return native;
  const root = native.rootName();
  return root === null ? native : native.alias(root);
}

/** `CASE WHEN cond THEN then ELSE otherwise END`. */
export function branch(cond: Expr, then: Operand, otherwise: Operand): Expr {
  return new Expr(JsExpr.case([cond._e], [toExpr(then)._e], toExpr(otherwise)._e));
}

/** The engine's list aggregate, which gives an empty list (not null) for an empty group. */
export function implodeNative(agg: JsExpr): Expr {
  return new Expr(JsExpr.func("coalesce", [agg, JsExpr.func("list_value", [])]));
}

/** Positional items (flattened) and the named ones (trailing plain objects, in order). */
export function splitItems(items: readonly SelectItem[]): {
  positional: Array<Operand | StructUnnest>;
  named: Array<[string, Operand]>;
} {
  const positional: Array<Operand | StructUnnest> = [];
  const named: Array<[string, Operand]> = [];
  for (const item of flatten(items)) {
    if (isPlainObject(item)) named.push(...Object.entries(item));
    else positional.push(item);
  }
  return { positional, named };
}

/** The native expressions of a select-like call. */
export function selectExprs(items: readonly SelectItem[]): JsExpr[] {
  const { positional, named } = splitItems(items);
  const exprs = positional.map((item) => {
    if (item instanceof StructUnnest) {
      throw new TypeError("struct.unnest() is only valid in select and withColumns");
    }
    return namedExpr(toColumnExpr(item));
  });
  for (const [name, value] of named) exprs.push(toColumnExpr(value)._e.alias(name));
  return exprs;
}

export class Expr {
  /** @internal The native expression. */
  readonly _e: JsExpr;

  /** Wraps a native expression; build expressions with `col`, `lit` and the methods here. */
  constructor(e: JsExpr) {
    this._e = e;
  }

  /** @internal Applies the engine function `name` to this expression and the operands. */
  _f(name: string, ...args: Operand[]): Expr {
    return new Expr(JsExpr.func(name, [this._e, ...args.map((a) => toExpr(a)._e)]));
  }

  private bin(op: string, other: Operand): Expr {
    return new Expr(this._e.binary(op, toExpr(other)._e));
  }

  /** Addition. */
  plus(other: Operand): Expr {
    return this.bin("+", other);
  }

  /** Subtraction. */
  minus(other: Operand): Expr {
    return this.bin("-", other);
  }

  /** Multiplication. */
  mul(other: Operand): Expr {
    return this.bin("*", other);
  }

  /** Division. */
  div(other: Operand): Expr {
    return this.bin("/", other);
  }

  /** Remainder with the sign of the divisor (Polars); the SQL `%` truncates (DuckDB). */
  mod(other: Operand): Expr {
    return this.bin("%", other).bin("+", other).bin("%", other);
  }

  /** Equality. */
  eq(other: Operand): Expr {
    return this.bin("==", other);
  }

  /** Inequality. */
  neq(other: Operand): Expr {
    return this.bin("!=", other);
  }

  /** Less than. */
  lt(other: Operand): Expr {
    return this.bin("<", other);
  }

  /** Less than or equal. */
  lte(other: Operand): Expr {
    return this.bin("<=", other);
  }

  /** Greater than. */
  gt(other: Operand): Expr {
    return this.bin(">", other);
  }

  /** Greater than or equal. */
  gte(other: Operand): Expr {
    return this.bin(">=", other);
  }

  /** Logical and. */
  and(other: Operand): Expr {
    return this.bin("and", other);
  }

  /** Logical or. */
  or(other: Operand): Expr {
    return this.bin("or", other);
  }

  /** String concatenation (SQL `||`). */
  concat(other: Operand): Expr {
    return this.bin("||", other);
  }

  /** Logical not. */
  not(): Expr {
    return new Expr(this._e.not());
  }

  /** Arithmetic negation. */
  neg(): Expr {
    return new Expr(this._e.neg());
  }

  /** Renames the output. */
  alias(name: string): Expr {
    return new Expr(this._e.alias(name));
  }

  /** Casts to `dtype`; `strict` false turns a failed conversion into null. */
  cast(dtype: string, strict = true): Expr {
    return new Expr(this._e.cast(dtype, strict));
  }

  /** True where the value is null. */
  isNull(): Expr {
    return new Expr(this._e.isNull());
  }

  /** True where the value is not null. */
  isNotNull(): Expr {
    return new Expr(this._e.isNotNull());
  }

  /** True where the value is one of `values`. */
  isIn(values: readonly Operand[]): Expr {
    return new Expr(this._e.isIn(values.map((v) => toExpr(v)._e), false));
  }

  /** `lower <= value <= upper`. */
  isBetween(lower: Operand, upper: Operand): Expr {
    return this.gte(lower).and(this.lte(upper));
  }

  /** Alias of `isBetween`. */
  between(lower: Operand, upper: Operand): Expr {
    return this.isBetween(lower, upper);
  }

  /** Replaces nulls with `value`. */
  fillNull(value: Operand): Expr {
    return new Expr(JsExpr.func("coalesce", [this._e, toExpr(value)._e]));
  }

  /** @internal An aggregate over this expression; a filtered one restricts it. */
  protected aggNative(name: string, distinct = false): JsExpr {
    return this._e.agg(name, distinct);
  }

  /** @internal An aggregate with extra arguments (quantile, max_by, corr ...). */
  protected aggWithNative(name: string, extra: readonly Operand[]): JsExpr {
    return this._e.aggWith(
      name,
      extra.map((e) => toExpr(e)._e),
    );
  }

  /** Sum of the non-null values. */
  sum(): Expr {
    return new Expr(this.aggNative("sum"));
  }

  /** Mean of the non-null values. */
  mean(): Expr {
    return new Expr(this.aggNative("mean"));
  }

  /** Alias of `mean`. */
  avg(): Expr {
    return this.mean();
  }

  /** Smallest value. */
  min(): Expr {
    return new Expr(this.aggNative("min"));
  }

  /** Largest value. */
  max(): Expr {
    return new Expr(this.aggNative("max"));
  }

  /** Number of non-null values. */
  count(): Expr {
    return new Expr(this.aggNative("count"));
  }

  /** Number of distinct non-null values. */
  nUnique(): Expr {
    return new Expr(this.aggNative("count", true));
  }

  /** Standard deviation (`ddof` 1: sample; any other value: population). */
  std(ddof = 1): Expr {
    return new Expr(this.aggNative(ddof === 1 ? "std" : "stddev_pop"));
  }

  /** Variance (`ddof` 1: sample; any other value: population). */
  var(ddof = 1): Expr {
    return new Expr(this.aggNative(ddof === 1 ? "var" : "var_pop"));
  }

  /** Median of the non-null values. */
  median(): Expr {
    return new Expr(this.aggNative("median"));
  }

  /** First value of the group. */
  first(): Expr {
    return new Expr(this.aggNative("first"));
  }

  /** Last value of the group. */
  last(): Expr {
    return new Expr(this.aggNative("last"));
  }

  /**
   * The `quantile` (0..1) of the non-null values. "linear" interpolates
   * (Polars, DuckDB `quantile_cont`); "disc" returns an existing value
   * (DuckDB `quantile_disc`).
   */
  quantile(quantile: number, interpolation: "linear" | "disc" = "linear"): Expr {
    const names = { linear: "quantile_cont", disc: "quantile_disc" } as const;
    if (interpolation !== "linear" && interpolation !== "disc") {
      throw new Error(`interpolation must be 'linear' or 'disc', got '${String(interpolation)}'`);
    }
    if (!(quantile >= 0 && quantile <= 1)) throw new Error("quantile must be between 0 and 1");
    return new Expr(this.aggWithNative(names[interpolation], [quantile]));
  }

  /** Like `quantile`, but allowed to approximate (currently exact). */
  approxQuantile(quantile: number): Expr {
    return new Expr(this.aggWithNative("approx_quantile", [quantile]));
  }

  /** Product of the non-null values (a float); null for no values. */
  product(): Expr {
    return new Expr(this.aggNative("product"));
  }

  /** True when every non-null value is true; null for no values. */
  all(): Expr {
    return new Expr(this.aggNative("bool_and"));
  }

  /** True when some value is true; null for no values. */
  any(): Expr {
    return new Expr(this.aggNative("bool_or"));
  }

  /** The value on the row where `by` is largest. */
  maxBy(by: Operand): Expr {
    return new Expr(this.aggWithNative("max_by", [by]));
  }

  /** The value on the row where `by` is smallest. */
  minBy(by: Operand): Expr {
    return new Expr(this.aggWithNative("min_by", [by]));
  }

  /** Pearson correlation with `other` over the rows where both are non-null. */
  corr(other: Operand): Expr {
    return new Expr(this.aggWithNative("corr", [other]));
  }

  /** Covariance with `other`; `ddof` 1 is the sample covariance, 0 the population one. */
  cov(other: Operand, ddof = 1): Expr {
    return new Expr(this.aggWithNative(ddof === 1 ? "covar_samp" : "covar_pop", [other]));
  }

  /** Slope of the least-squares fit of this column (y) on `x`. */
  slope(x: Operand): Expr {
    return new Expr(this.aggWithNative("regr_slope", [x]));
  }

  /**
   * Restricts an aggregation to the rows matching `predicate`. Works both as
   * `col("x").sum().filter(p)` and `col("x").filter(p).sum()`.
   */
  filter(predicate: Operand): Expr {
    const p = toExpr(predicate);
    if (this._e.containsAgg()) return new Expr(this._e.aggFilter(p._e));
    return new FilteredExpr(this, p);
  }

  /** Every value of the group (or of the whole column) in one list; no rows give an empty list. */
  implode(): Expr {
    return implodeNative(this.aggNative("array_agg"));
  }

  /** Absolute value. */
  abs(): Expr {
    return this._f("abs");
  }

  /** Rounds to `decimals` decimal places. */
  round(decimals = 0): Expr {
    return this._f("round", decimals);
  }

  /** Square root. */
  sqrt(): Expr {
    return this._f("sqrt");
  }

  /** e raised to this value. */
  exp(): Expr {
    return this._f("exp");
  }

  /** Natural logarithm. */
  log(): Expr {
    return this._f("ln");
  }

  /** Base-10 logarithm. */
  log10(): Expr {
    return this._f("log10");
  }

  /** Rounds down. */
  floor(): Expr {
    return this._f("floor");
  }

  /** Rounds up. */
  ceil(): Expr {
    return this._f("ceil");
  }

  /** This value raised to `exponent`. */
  pow(exponent: Operand): Expr {
    return this._f("power", exponent);
  }

  /** Sine. */
  sin(): Expr {
    return this._f("sin");
  }

  /** Cosine. */
  cos(): Expr {
    return this._f("cos");
  }

  /** Tangent. */
  tan(): Expr {
    return this._f("tan");
  }

  /** Arc sine (NaN outside [-1, 1] in Polars; DuckDB raises an error). */
  arcsin(): Expr {
    return this._f("asin");
  }

  /** Arc cosine. */
  arccos(): Expr {
    return this._f("acos");
  }

  /** Arc tangent. */
  arctan(): Expr {
    return this._f("atan");
  }

  /** Angle of the point (x, this). */
  arctan2(x: Operand): Expr {
    return this._f("atan2", x);
  }

  /** Radians to degrees. */
  degrees(): Expr {
    return this._f("degrees");
  }

  /** Degrees to radians. */
  radians(): Expr {
    return this._f("radians");
  }

  /** Limits values to [lowerBound, upperBound]; null leaves a side open. Nulls stay null. */
  clip(lowerBound?: Operand, upperBound?: Operand): Expr {
    return this._f("clip", lowerBound ?? null, upperBound ?? null);
  }

  /** -1, 0 or 1 by the sign of each value. */
  sign(): Expr {
    return this._f("sign");
  }

  /** True for NaN; null stays null. */
  isNan(): Expr {
    return this._f("isnan");
  }

  /** False for NaN; null stays null. */
  isNotNan(): Expr {
    return this.isNan().not();
  }

  /** Equality where null equals null. */
  eqMissing(other: Operand): Expr {
    return this._f("eq_null_safe", other);
  }

  /** Inequality where null equals null. */
  neMissing(other: Operand): Expr {
    return this.eqMissing(other).not();
  }

  /** String functions. */
  get str(): StrNamespace {
    return new StrNamespace(this);
  }

  /** Date and time functions. */
  get dt(): DtNamespace {
    return new DtNamespace(this);
  }

  /** List functions (`col("tags").list.len()`). */
  get list(): ListNamespace {
    return new ListNamespace(this);
  }

  /** Struct functions (`col("s").struct.field("a")`). */
  get struct(): StructNamespace {
    return new StructNamespace(this);
  }

  /** Evaluates the aggregates and window functions in this expression per group. */
  over(partitionBy?: Operand | readonly Operand[], options?: OverOptions): Expr {
    return overExpr(this, partitionBy, options);
  }

  /** Rank of each value; nulls get a null rank. */
  rank(method: RankMethod = "average", options: { descending?: boolean } = {}): Expr {
    return rankExpr(this, method, options.descending ?? false);
  }

  /** The value `n` rows before the current one (negative `n`: after). */
  shift(n = 1, fillValue?: Operand): Expr {
    return shiftExpr(this, n, fillValue);
  }

  /** Difference with the value `n` rows before. */
  diff(n = 1): Expr {
    return diffExpr(this, n);
  }

  /** Running sum. */
  cumSum(options: { reverse?: boolean } = {}): Expr {
    return cumulativeExpr(this, "sum", options.reverse ?? false, true);
  }

  /** Running minimum. */
  cumMin(options: { reverse?: boolean } = {}): Expr {
    return cumulativeExpr(this, "min", options.reverse ?? false, true);
  }

  /** Running maximum. */
  cumMax(options: { reverse?: boolean } = {}): Expr {
    return cumulativeExpr(this, "max", options.reverse ?? false, true);
  }

  /** Running count of non-null values. */
  cumCount(options: { reverse?: boolean } = {}): Expr {
    return cumulativeExpr(this, "count", options.reverse ?? false, false);
  }

  /** Sum over the last `windowSize` rows. */
  rollingSum(windowSize: number, options?: RollingOptions): Expr {
    return rollingExpr(this, "sum", windowSize, options);
  }

  /** Mean over the last `windowSize` rows. */
  rollingMean(windowSize: number, options?: RollingOptions): Expr {
    return rollingExpr(this, "mean", windowSize, options);
  }

  /** Minimum over the last `windowSize` rows. */
  rollingMin(windowSize: number, options?: RollingOptions): Expr {
    return rollingExpr(this, "min", windowSize, options);
  }

  /** Maximum over the last `windowSize` rows. */
  rollingMax(windowSize: number, options?: RollingOptions): Expr {
    return rollingExpr(this, "max", windowSize, options);
  }

  /** Standard deviation over the last `windowSize` rows. */
  rollingStd(windowSize: number, options?: RollingOptions): Expr {
    const name = (options?.ddof ?? 1) === 1 ? "std" : "stddev_pop";
    return rollingExpr(this, name, windowSize, options);
  }

  /** Variance over the last `windowSize` rows. */
  rollingVar(windowSize: number, options?: RollingOptions): Expr {
    const name = (options?.ddof ?? 1) === 1 ? "var" : "var_pop";
    return rollingExpr(this, name, windowSize, options);
  }
}

/** `col(x).filter(pred)`: only meaningful when followed by an aggregation. */
class FilteredExpr extends Expr {
  private readonly predicate: Expr;

  constructor(base: Expr, predicate: Expr) {
    super(base._e);
    this.predicate = predicate;
  }

  protected override aggNative(name: string, distinct = false): JsExpr {
    return super.aggNative(name, distinct).aggFilter(this.predicate._e);
  }

  protected override aggWithNative(name: string, extra: readonly Operand[]): JsExpr {
    return super.aggWithNative(name, extra).aggFilter(this.predicate._e);
  }
}
