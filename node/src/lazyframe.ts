import type * as arrow from "apache-arrow";
import { JsSessionContext, type DeltaWrite, type JsLazyFrame } from "../native/index.js";
import { DataFrame } from "./dataframe.js";
import { GroupBy } from "./groupby.js";
import {
  Expr,
  flatten,
  perKey,
  selectExprs,
  toColumnExpr,
  toExpr,
  type Nested,
  type Operand,
  type SelectItem,
} from "./expr.js";
import * as frameOps from "./frame_ops.js";
import type { FillNullOptions, RowIndexOptions, SampleOptions, Subset, UniqueOptions } from "./frame_ops.js";
import { normalizeStorageOptions, type StorageOptions } from "./runtime.js";
import { ResultStream } from "./stream.js";
import type { SqlParams } from "./session.js";
import { StructUnnest } from "./struct.js";

export type JoinHow = "inner" | "left" | "right" | "full" | "semi" | "anti" | "cross";

export interface JoinOptions {
  /** The key columns, the same on both sides. */
  on?: Nested<Operand>;
  how?: JoinHow;
  leftOn?: Nested<Operand>;
  rightOn?: Nested<Operand>;
  suffix?: string;
}

export interface SortOptions {
  descending?: boolean | readonly boolean[];
  nullsLast?: boolean | readonly boolean[];
}

export interface SinkDeltaOptions {
  mode?: "error" | "append" | "overwrite" | "ignore";
  partitionBy?: string | readonly string[];
  storageOptions?: StorageOptions;
  /** "merge" adds the result's new columns to the table on append or overwrite. */
  schemaMode?: "merge";
}

export interface SinkParquetOptions {
  compression?: string;
  rowGroupSize?: number;
  storageOptions?: StorageOptions;
  partitionBy?: string | readonly string[];
}

export interface SinkCsvOptions {
  separator?: string;
  includeHeader?: boolean;
  storageOptions?: StorageOptions;
}

/** Column names given as strings or expressions (their output names). */
export type ColumnsArg = Nested<string | Expr>;

function namesOfColumns(columns: readonly ColumnsArg[]): string[] {
  return flatten(columns).map((c) => (typeof c === "string" ? c : c._e.outputName()));
}

function partitionList(partitionBy: string | readonly string[] | undefined): string[] | undefined {
  if (partitionBy === undefined) return undefined;
  const cols = typeof partitionBy === "string" ? [partitionBy] : [...partitionBy];
  return cols.length > 0 ? cols : undefined;
}

/** A lazy query: nothing runs until `collect`, `stream` or a sink. */
export class LazyFrame {
  /** @internal The native plan. */
  readonly _lf: JsLazyFrame;

  /** @internal Wraps a native plan. */
  constructor(lf: JsLazyFrame) {
    this._lf = lf;
  }

  /** The column names. */
  get columns(): string[] {
    return this._lf.columns();
  }

  /** The column types, by name. */
  get schema(): Record<string, string> {
    return Object.fromEntries(this._lf.schema().map((f) => [f.name, f.type]));
  }

  /** Keeps the rows where every predicate holds. */
  filter(...predicates: Array<Nested<Operand>>): LazyFrame {
    const preds = flatten(predicates).map((p) => toExpr(p));
    if (preds.length === 0) return this;
    const combined = preds.slice(1).reduce((acc, q) => acc.and(q), preds[0]);
    return new LazyFrame(this._lf.filter(combined._e));
  }

  /** Alias of `filter`. */
  where(...predicates: Array<Nested<Operand>>): LazyFrame {
    return this.filter(...predicates);
  }

  private expandUnnests(items: readonly SelectItem[]): SelectItem[] {
    return flatten(items).flatMap((item) => (item instanceof StructUnnest ? item.expand(this._lf) : [item]));
  }

  /** The named expressions as the only columns. */
  select(...items: SelectItem[]): LazyFrame {
    return new LazyFrame(this._lf.select(selectExprs(this.expandUnnests(items))));
  }

  /** Adds or replaces columns by name. */
  withColumns(...items: SelectItem[]): LazyFrame {
    return new LazyFrame(this._lf.withColumns(selectExprs(this.expandUnnests(items))));
  }

  /** Groups the rows by the key expressions; name the aggregates with `agg`. */
  groupBy(...keys: Array<Nested<Operand>>): GroupBy {
    return new GroupBy(
      this,
      flatten(keys).map((k) => toColumnExpr(k)._e),
    );
  }

  /** Aggregates the whole frame into one row. */
  agg(...items: SelectItem[]): LazyFrame {
    return new LazyFrame(this._lf.groupByAgg([], selectExprs(items)));
  }

  /** Joins on the key columns (`on`, or `leftOn` and `rightOn`); "cross" pairs every row. */
  join(other: LazyFrame | DataFrame, options: JoinOptions = {}): LazyFrame {
    const otherLf = other instanceof DataFrame ? other.lazy() : other;
    const how = options.how ?? "inner";
    const suffix = options.suffix ?? "_right";
    if (how === "cross") return new LazyFrame(this._lf.join(otherLf._lf, [], [], "cross", suffix));
    const leftSpec = options.on ?? options.leftOn;
    const rightSpec = options.on ?? options.rightOn;
    if (leftSpec === undefined || rightSpec === undefined) {
      throw new Error("join requires `on` or both `leftOn` and `rightOn`");
    }
    const lk = flatten([leftSpec]).map((x) => toColumnExpr(x)._e);
    const rk = flatten([rightSpec]).map((x) => toColumnExpr(x)._e);
    return new LazyFrame(this._lf.join(otherLf._lf, lk, rk, how, suffix));
  }

  /** Sorts by the keys; `descending` and `nullsLast` are one flag, or one per key. */
  sort(by: Nested<Operand>, options: SortOptions = {}): LazyFrame {
    const keys = flatten([by]).map((k) => toColumnExpr(k)._e);
    const n = keys.length;
    return new LazyFrame(
      this._lf.sort(keys, perKey(options.descending ?? false, n), perKey(options.nullsLast ?? false, n)),
    );
  }

  /** The first `n` rows. */
  limit(n = 5): LazyFrame {
    return new LazyFrame(this._lf.slice(0, n));
  }

  /** Alias of `limit`. */
  head(n = 5): LazyFrame {
    return this.limit(n);
  }

  /** `length` rows from `offset` (all of them when no length). */
  slice(offset: number, length?: number | null): LazyFrame {
    return new LazyFrame(this._lf.slice(offset, length));
  }

  /** Drops duplicate rows, comparing `subset` (default all columns). */
  unique(options: UniqueOptions = {}): LazyFrame {
    return frameOps.unique(this, options);
  }

  /** Drops duplicate rows over all columns. */
  distinct(): LazyFrame {
    return new LazyFrame(this._lf.distinct());
  }

  /** Removes the named columns. */
  drop(...columns: Array<Nested<string>>): LazyFrame {
    return new LazyFrame(this._lf.drop(flatten(columns)));
  }

  /** One row per element of the list columns, in their place. */
  explode(...columns: ColumnsArg[]): LazyFrame {
    return new LazyFrame(this._lf.explode(namesOfColumns(columns)));
  }

  /** Struct columns replaced by one column per field; with `separator`, fields are named `column<separator>field`. */
  unnest(columns: ColumnsArg, options: { separator?: string } = {}): LazyFrame {
    return new LazyFrame(this._lf.unnest(namesOfColumns([columns]), options.separator ?? null));
  }

  /** Renames the columns of `mapping` (old name to new name). */
  rename(mapping: Record<string, string>): LazyFrame {
    return new LazyFrame(this._lf.rename(Object.keys(mapping), Object.values(mapping)));
  }

  /** Stacks these rows on top of the others' (same columns). */
  union(...others: Array<LazyFrame | DataFrame>): LazyFrame {
    const lfs = flatten(others).map((o) => (o instanceof DataFrame ? o.lazy() : o)._lf);
    return new LazyFrame(this._lf.union(lfs));
  }

  /** Runs SQL against this frame, named `tableName` (default `self`); `params` binds the placeholders. */
  async sql(query: string, options: { tableName?: string; params?: SqlParams } = {}): Promise<LazyFrame> {
    const ctx = new JsSessionContext();
    ctx.registerLazy(options.tableName ?? "self", this._lf);
    return new LazyFrame(await ctx.sql(query, options.params));
  }

  /** Fills nulls with `value`, or with a strategy (forward, backward, min, max, mean, zero, one). */
  fillNull(options: FillNullOptions): LazyFrame {
    return frameOps.fillNull(this, options);
  }

  /** Replaces NaN with `value` in the float columns (all of them by default). */
  fillNan(value: Operand, subset?: Subset): LazyFrame {
    return frameOps.fillNan(this, value, subset);
  }

  /** Keeps the rows where the columns (default all) are not null. */
  dropNulls(subset?: Subset): LazyFrame {
    return frameOps.dropNulls(this, subset);
  }

  /** Drops rows with NaN in the float columns (default all); nulls are kept. */
  dropNans(subset?: Subset): LazyFrame {
    return frameOps.dropNans(this, subset);
  }

  /** Random rows: exactly `n` (or `fraction` of them); the same seed gives the same rows. */
  async sample(options: SampleOptions): Promise<LazyFrame> {
    return frameOps.sample(this, options);
  }

  /** Adds a row number as the first column. */
  withRowIndex(options: RowIndexOptions = {}): LazyFrame {
    return frameOps.withRowIndex(this, options);
  }

  /** Stacks frames matching the columns by name, filling missing ones with nulls. */
  unionByName(...others: Array<LazyFrame | DataFrame>): LazyFrame {
    return frameOps.unionByName(this, ...others);
  }

  /** The plan as text; `optimized` false shows it before the optimizer runs. */
  async explain(optimized = true): Promise<string> {
    return this._lf.explain(optimized);
  }

  /** Runs the query. */
  async collect(): Promise<DataFrame> {
    return new DataFrame(await this._lf.collect());
  }

  /** Runs the query and returns its first `n` rows. */
  async fetch(n = 5): Promise<DataFrame> {
    return this.limit(n).collect();
  }

  /** Starts the query; its result is read batch by batch. */
  async stream(): Promise<ResultStream> {
    return new ResultStream(await this._lf.stream());
  }

  /** The result's Arrow record batches, produced as the query runs; breaking out stops it. */
  async *iterBatches(): AsyncGenerator<arrow.RecordBatch> {
    const stream = await this.stream();
    try {
      for await (const batch of stream) yield batch;
    } finally {
      stream.close();
    }
  }

  /** Writes the result to a Delta table while it is produced; resolves to the commit. */
  async sinkDelta(path: string, options: SinkDeltaOptions = {}): Promise<DeltaWrite> {
    if (options.schemaMode !== undefined && options.schemaMode !== "merge") {
      throw new Error("schemaMode must be undefined or 'merge'");
    }
    return this._lf.sinkDelta(
      path,
      options.mode ?? "error",
      partitionList(options.partitionBy),
      normalizeStorageOptions(options.storageOptions),
      options.schemaMode === "merge",
    );
  }

  /** Writes the result to Parquet while it is produced; resolves to the rows written. */
  async sinkParquet(path: string, options: SinkParquetOptions = {}): Promise<number> {
    return this._lf.sinkParquet(
      path,
      options.compression ?? "zstd",
      options.rowGroupSize ?? null,
      normalizeStorageOptions(options.storageOptions),
      partitionList(options.partitionBy),
    );
  }

  /** Writes the result to CSV while it is produced; resolves to the rows written. */
  async sinkCsv(path: string, options: SinkCsvOptions = {}): Promise<number> {
    return this._lf.sinkCsv(
      path,
      options.includeHeader ?? true,
      options.separator ?? ",",
      normalizeStorageOptions(options.storageOptions),
    );
  }

  /** Writes the result as NDJSON while it is produced; resolves to the rows written. */
  async sinkNdjson(path: string, options: { storageOptions?: StorageOptions } = {}): Promise<number> {
    return this._lf.sinkNdjson(path, normalizeStorageOptions(options.storageOptions));
  }

  /** This frame (lazy frames are already lazy). */
  lazy(): LazyFrame {
    return this;
  }
}
