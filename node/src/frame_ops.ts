import { DataFrame } from "./dataframe.js";
import { fromColumns } from "./convert.js";
import { branch, Expr, toExpr, type Operand } from "./expr.js";
import { coalesce, col, count, lit, len, rand, rowNumber } from "./functions.js";
import { LazyFrame } from "./lazyframe.js";
import type { Frame } from "./window.js";

/** NaN as an expression; the engine tests for NaN by equality with it. */
const NAN = (): Expr => lit(Number.NaN);
const IDX = "__row_index";
const RN = "__rank";
const CNT = "__group_size";
const KEY = "__hash";
const POS = "__pos";
const DRAW = "__draw";
const KEEP = ["any", "first", "last", "none"] as const;
const FLOATS = ["Float32", "Float64"];
const NUMERIC_PREFIXES = ["Int", "UInt", "Float", "Decimal"];
/** Seeds are reduced to this range. */
const P = 2147483647;
const QUANTILES = [0.25, 0.5, 0.75] as const;
const STATS = ["count", "null_count", "mean", "std", "min", "25%", "50%", "75%", "max"] as const;

export type Subset = string | readonly string[];
export type KeepRule = (typeof KEEP)[number];
export type FillStrategy = "forward" | "backward" | "min" | "max" | "mean" | "zero" | "one";

export interface FillNullOptions {
  value?: Operand;
  strategy?: FillStrategy;
  subset?: Subset;
}

export interface UniqueOptions {
  subset?: Subset;
  /** Which row of each duplicate group to keep; "none" keeps the groups with one row. */
  keep?: KeepRule;
  maintainOrder?: boolean;
}

export interface SampleOptions {
  n?: number;
  fraction?: number;
  seed?: number;
  withReplacement?: boolean;
}

export interface RowIndexOptions {
  name?: string;
  offset?: number;
}

export interface ConcatOptions {
  how?: "vertical" | "diagonal";
}

function namesOf(lf: LazyFrame, subset: Subset | undefined): string[] {
  if (subset === undefined || subset === null) return lf.columns;
  const names = typeof subset === "string" ? [subset] : [...subset];
  const missing = names.filter((n) => !lf.columns.includes(n));
  if (missing.length > 0) throw new Error(`unknown columns: ${missing.join(", ")}`);
  return names;
}

function floatNamesOf(lf: LazyFrame, subset: Subset | undefined): string[] {
  const schema = lf.schema;
  if (subset === undefined || subset === null) {
    return Object.keys(schema).filter((n) => FLOATS.includes(schema[n]));
  }
  const names = namesOf(lf, subset);
  const bad = names.filter((n) => !FLOATS.includes(schema[n]));
  if (bad.length > 0) throw new TypeError(`NaN handling needs float columns, got: ${bad.join(", ")}`);
  return names;
}

function isNumeric(dtype: string): boolean {
  return NUMERIC_PREFIXES.some((p) => dtype.startsWith(p));
}

/** Replaces nulls with `value`, or with a strategy (forward, backward, min, max, mean, zero, one). */
export function fillNull(lf: LazyFrame, options: FillNullOptions = {}): LazyFrame {
  const { value, strategy, subset } = options;
  if ((value === undefined || value === null) === (strategy === undefined || strategy === null)) {
    throw new Error("pass exactly one of `value` or `strategy`");
  }
  const names = namesOf(lf, subset);
  if (strategy === "forward" || strategy === "backward") return fillDirectional(lf, names, strategy);
  return lf.withColumns(names.map((n) => fillExpr(n, value, strategy)));
}

function fillExpr(name: string, value: Operand | undefined, strategy: FillStrategy | undefined): Expr {
  const c = col(name);
  let fill: Expr;
  if (strategy === undefined) fill = toExpr(value ?? null);
  else if (strategy === "zero") fill = lit(0);
  else if (strategy === "one") fill = lit(1);
  else if (strategy === "min" || strategy === "max" || strategy === "mean") fill = c[strategy]().over();
  else throw new Error(`unknown fill strategy: '${String(strategy)}'`);
  return coalesce(c, fill).alias(name);
}

/** Forward fill takes the last non-null up to the row; backward takes the first non-null from the row on. */
function fillDirectional(lf: LazyFrame, names: string[], strategy: "forward" | "backward"): LazyFrame {
  const frame: Frame = strategy === "forward" ? { units: "rows", start: null, end: 0 } : { units: "rows", start: 0, end: null };
  const pick = strategy === "forward" ? "last" : "first";
  const order = col(IDX);
  const exprs = names.map((n) => col(n)[pick]().over(undefined, { orderBy: order, frame }).alias(n));
  return lf.withRowIndex({ name: IDX }).withColumns(exprs).drop(IDX);
}

/** Replaces NaN with `value` in float columns (all of them by default). */
export function fillNan(lf: LazyFrame, value: Operand, subset?: Subset): LazyFrame {
  const exprs = floatNamesOf(lf, subset).map((n) => {
    const c = col(n);
    return branch(c.eq(NAN()), value, c).alias(n);
  });
  return exprs.length > 0 ? lf.withColumns(exprs) : lf;
}

/** Keeps the rows where every column of `subset` (default all) is not null. */
export function dropNulls(lf: LazyFrame, subset?: Subset): LazyFrame {
  const names = namesOf(lf, subset);
  if (names.length === 0) return lf;
  return lf.filter(...names.map((n) => col(n).isNotNull()));
}

/** Drops rows with NaN in any float column of `subset`; nulls are kept. */
export function dropNans(lf: LazyFrame, subset?: Subset): LazyFrame {
  const names = floatNamesOf(lf, subset);
  if (names.length === 0) return lf;
  return lf.filter(...names.map((n) => col(n).isNull().or(col(n).neq(NAN()))));
}

/** Drops duplicate rows, comparing `subset` (default all columns). Nulls compare equal. */
export function unique(lf: LazyFrame, options: UniqueOptions = {}): LazyFrame {
  const keep = options.keep ?? "any";
  if (!KEEP.includes(keep)) throw new Error(`keep must be one of ${KEEP.join(", ")}, got '${keep}'`);
  const names = namesOf(lf, options.subset);
  if (keep === "any" && (options.subset === undefined || options.subset === null)) {
    return lf.distinct();
  }
  const ranked = lf.withRowIndex({ name: IDX }).withColumns(
    rowNumber().over(names, { orderBy: col(IDX) }).alias(RN),
    count().over(names).alias(CNT),
  );
  let pred: Expr;
  if (keep === "last") pred = col(RN).eq(col(CNT));
  else if (keep === "none") pred = col(CNT).eq(1);
  else pred = col(RN).eq(1);
  let out = ranked.filter(pred);
  if (options.maintainOrder) out = out.sort(IDX);
  return out.drop(IDX, RN, CNT);
}

/** A float in [0, 1) that depends only on (seed, x). */
function uniform(x: Expr, seed: number): Expr {
  return rand({ seed: ((seed % P) + P) % P, key: x });
}

/** Random rows: exactly `n` (or round(fraction * rows)). The same seed gives the same rows, in their original order. */
export async function sample(lf: LazyFrame, options: SampleOptions): Promise<LazyFrame> {
  const { n: count0, fraction, seed, withReplacement = false } = options;
  if ((count0 === undefined) === (fraction === undefined)) throw new Error("pass exactly one of `n` or `fraction`");
  const total = await height(lf);
  let n: number;
  if (count0 === undefined) {
    if (fraction === undefined || fraction < 0) throw new Error("fraction must be >= 0");
    n = pyRound(total * fraction);
  } else {
    n = count0;
  }
  if (n < 0) throw new Error("n must be >= 0");
  if (!withReplacement && n > total) throw new Error(`cannot take ${n} rows without replacement from ${total}`);
  const s = seed ?? Math.floor(Math.random() * P);
  return withReplacement ? sampleWithReplacement(lf, n, s, total) : sampleWithout(lf, n, s);
}

/** Python's round(): halves go to the even neighbour. */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

async function height(lf: LazyFrame): Promise<number> {
  const df = await lf.agg(len().alias("n")).collect();
  return Number(await df.item());
}

function sampleWithout(lf: LazyFrame, n: number, seed: number): LazyFrame {
  const idx = col(IDX);
  const keyed = lf.withRowIndex({ name: IDX }).withColumns(uniform(idx, seed).alias(KEY));
  const ranked = keyed.withColumns(rowNumber().over(undefined, { orderBy: [col(KEY), idx] }).alias(RN));
  return ranked.filter(col(RN).lte(n)).sort(IDX).drop(IDX, KEY, RN);
}

async function sampleWithReplacement(lf: LazyFrame, n: number, seed: number, total: number): Promise<LazyFrame> {
  if (n > 0 && total === 0) throw new Error("cannot sample rows from an empty frame");
  const draws = (await fromColumns({ [DRAW]: Array.from({ length: n }, (_, i) => i) })).lazy();
  const positions = draws.withColumns(
    uniform(col(DRAW), seed).mul(total).floor().cast("Int64").alias(POS),
  );
  const joined = lf.withRowIndex({ name: IDX }).join(positions, { leftOn: IDX, rightOn: POS, how: "inner" });
  return joined.sort(DRAW).drop(IDX, POS, DRAW);
}

/** Adds a row number as the first column (`offset` for the first row's number). */
export function withRowIndex(lf: LazyFrame, options: RowIndexOptions = {}): LazyFrame {
  const name = options.name ?? "index";
  const offset = options.offset ?? 0;
  if (lf.columns.includes(name)) throw new Error(`column '${name}' already exists`);
  const index = rowNumber().over().plus(offset - 1);
  return lf.select(index.alias(name), ...lf.columns.map((c) => col(c)));
}

/** Stacks frames matching columns by name (see `concat` with how "diagonal"). */
export function unionByName(lf: LazyFrame, ...others: Array<LazyFrame | DataFrame>): LazyFrame {
  const frames: [LazyFrame, ...Array<LazyFrame | DataFrame>] = [lf, ...others];
  return concat(frames, { how: "diagonal" });
}

function supertype(a: string, b: string): string {
  if (a === b) return a;
  if (a === "Null") return b;
  if (b === "Null") return a;
  if (isNumeric(a) && isNumeric(b)) {
    const floats = a.startsWith("Float") || a.startsWith("Decimal") || b.startsWith("Float") || b.startsWith("Decimal");
    return floats ? "Float64" : "Int64";
  }
  return "Utf8";
}

/** Column names in first-seen order, each with a common type; mixed non-numeric types become Utf8. */
function unify(schemas: Array<Record<string, string>>): { names: string[]; types: Record<string, string> } {
  const names: string[] = [];
  const types: Record<string, string> = {};
  for (const schema of schemas) {
    for (const [name, dtype] of Object.entries(schema)) {
      if (Object.hasOwn(types, name)) types[name] = supertype(types[name], dtype);
      else {
        types[name] = dtype;
        names.push(name);
      }
    }
  }
  return { names, types };
}

function align(frames: LazyFrame[], names: string[], types: Record<string, string>): LazyFrame[] {
  return frames.map((f) => {
    const schema = f.schema;
    const exprs = names.map((name) => {
      const dt = types[name];
      let e: Expr;
      if (!Object.hasOwn(schema, name)) e = lit(null).cast(dt);
      else if (schema[name] !== dt) e = col(name).cast(dt);
      else e = col(name);
      return e.alias(name);
    });
    return f.select(exprs);
  });
}

function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Stacks frames: "vertical" needs identical columns, "diagonal" matches them by name. A DataFrame first gives a DataFrame. */
export function concat(frames: readonly [LazyFrame, ...Array<LazyFrame | DataFrame>], options?: ConcatOptions): LazyFrame;
export function concat(frames: readonly [DataFrame, ...Array<LazyFrame | DataFrame>], options?: ConcatOptions): Promise<DataFrame>;
export function concat(frames: readonly (LazyFrame | DataFrame)[], options?: ConcatOptions): LazyFrame | Promise<DataFrame>;
export function concat(frames: readonly (LazyFrame | DataFrame)[], options: ConcatOptions = {}): LazyFrame | Promise<DataFrame> {
  if (frames.length === 0) throw new Error("concat needs at least one frame");
  const lazies = frames.map((f) => (f instanceof DataFrame ? f.lazy() : f));
  const how = options.how ?? "vertical";
  let result: LazyFrame;
  if (how === "vertical") {
    const cols = lazies[0].columns;
    if (lazies.slice(1).some((f) => !sameNames(f.columns, cols))) {
      throw new Error("vertical concat needs the same columns; use how: 'diagonal'");
    }
    result = lazies.length > 1 ? lazies[0].union(...lazies.slice(1)) : lazies[0];
  } else if (how === "diagonal") {
    const { names, types } = unify(lazies.map((f) => f.schema));
    const aligned = align(lazies, names, types);
    result = aligned.length > 1 ? aligned[0].union(...aligned.slice(1)) : aligned[0];
  } else {
    throw new Error(`how must be 'vertical' or 'diagonal', got '${String(how)}'`);
  }
  return frames[0] instanceof LazyFrame ? result : result.collect();
}

/** Summary statistics as text, one row per statistic (count, null_count, mean, std, min, quartiles, max). */
export async function describe(df: DataFrame): Promise<DataFrame> {
  const lf = df.lazy();
  const entries = Object.entries(lf.schema);
  const aggs = [len().alias("__rows"), ...entries.flatMap(([name, dtype], i) => columnAggs(i, name, isNumeric(dtype)))];
  const rows = await (await lf.agg(...aggs).collect()).toRecords();
  const row = rows[0];
  const total = Number(row.__rows);
  const data: Record<string, unknown[]> = { statistic: [...STATS] };
  entries.forEach(([name], i) => {
    data[name] = columnSummary(row, i, total);
  });
  return fromColumns(data);
}

/** The aggregates of one column, named by its position (names may clash). */
function columnAggs(i: number, name: string, numeric: boolean): Expr[] {
  const c = col(name);
  const aggs = [c.count().alias(`${i}:count`), c.min().alias(`${i}:min`), c.max().alias(`${i}:max`)];
  if (numeric) {
    aggs.push(c.mean().alias(`${i}:mean`), c.std().alias(`${i}:std`));
    for (const q of QUANTILES) aggs.push(c.quantile(q).alias(`${i}:q${q}`));
  }
  return aggs;
}

function columnSummary(row: Record<string, unknown>, i: number, total: number): Array<string | null> {
  const count = Number(row[`${i}:count`]);
  const values: Record<string, unknown> = {
    count,
    null_count: total - count,
    mean: row[`${i}:mean`],
    std: row[`${i}:std`],
    min: row[`${i}:min`],
    max: row[`${i}:max`],
    "25%": row[`${i}:q0.25`],
    "50%": row[`${i}:q0.5`],
    "75%": row[`${i}:q0.75`],
  };
  return STATS.map((s) => text(values[s]));
}

function text(x: unknown): string | null {
  if (x === null || x === undefined) return null;
  if (x instanceof Date) return x.toISOString().slice(0, 19).replace("T", " ");
  return String(x);
}
