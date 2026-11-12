import * as arrow from "apache-arrow";
import { JsDataFrame } from "../native/index.js";
import { tableToColumns, tableToRecords, tableToRows } from "./convert.js";
import { EagerGroupBy } from "./groupby.js";
import type { Nested, Operand, SelectItem } from "./expr.js";
import * as frameOps from "./frame_ops.js";
import type { FillNullOptions, RowIndexOptions, SampleOptions, Subset, UniqueOptions } from "./frame_ops.js";
import {
  LazyFrame,
  type ColumnsArg,
  type JoinOptions,
  type SinkDeltaOptions,
  type SortOptions,
} from "./lazyframe.js";
import { normalizeStorageOptions, type StorageOptions } from "./runtime.js";
import { defaultSession, type SqlParams } from "./session.js";

/** A materialised result, held by the engine as Arrow record batches. */
export class DataFrame {
  /** @internal The native frame. */
  readonly _df: JsDataFrame;

  /** @internal Wraps a native frame. */
  constructor(df: JsDataFrame) {
    this._df = df;
  }

  /** Rows and columns, as `[height, width]`. */
  get shape(): [number, number] {
    return [this._df.numRows(), this._df.numColumns()];
  }

  /** The number of rows. */
  get height(): number {
    return this._df.numRows();
  }

  /** The number of columns. */
  get width(): number {
    return this._df.numColumns();
  }

  /** The column names. */
  get columns(): string[] {
    return this._df.columns();
  }

  /** The column types, by name. */
  get schema(): Record<string, string> {
    return Object.fromEntries(this._df.schema().map((f) => [f.name, f.type]));
  }

  /** This frame as a lazy frame, for the plan API. */
  lazy(): LazyFrame {
    return new LazyFrame(this._df.lazy(defaultSession()));
  }

  /** The rows as an Arrow table. */
  async toArrow(): Promise<arrow.Table> {
    return arrow.tableFromIPC(await this._df.toIpc());
  }

  /** One plain object per row; int64 is a number when safe, dates are Date, decimals are strings. */
  async toRecords(): Promise<Record<string, unknown>[]> {
    return tableToRecords(await this.toArrow());
  }

  /** One array of values per column, by name. */
  async toColumns(): Promise<Record<string, unknown[]>> {
    return tableToColumns(await this.toArrow());
  }

  /** One array of values per row, in column order. */
  async rows(): Promise<unknown[][]> {
    return tableToRows(await this.toArrow());
  }

  /** The value of a 1x1 frame. */
  async item(): Promise<unknown> {
    const [height, width] = this.shape;
    if (height !== 1 || width !== 1) {
      throw new Error(`item() requires a 1x1 frame, got shape (${height}, ${width})`);
    }
    return (await this.rows())[0][0];
  }

  /** The first `n` rows as a text table. */
  async format(n = 10): Promise<string> {
    return this._df.toTableString(n);
  }

  /** Prints the first `n` rows. */
  async show(n = 10): Promise<void> {
    console.log(await this.format(n));
  }

  /** The first `n` rows. */
  async head(n = 5): Promise<DataFrame> {
    return new DataFrame(await this._df.slice(0, n));
  }

  /** `length` rows from `offset`. */
  async slice(offset: number, length: number): Promise<DataFrame> {
    return new DataFrame(await this._df.slice(offset, length));
  }

  /** Keeps the rows where every predicate holds. */
  async filter(...predicates: Array<Nested<Operand>>): Promise<DataFrame> {
    return this.lazy().filter(...predicates).collect();
  }

  /** The named expressions as the only columns. */
  async select(...items: SelectItem[]): Promise<DataFrame> {
    return this.lazy().select(...items).collect();
  }

  /** Adds or replaces columns by name. */
  async withColumns(...items: SelectItem[]): Promise<DataFrame> {
    return this.lazy().withColumns(...items).collect();
  }

  /** Sorts by the keys. */
  async sort(by: Nested<Operand>, options: SortOptions = {}): Promise<DataFrame> {
    return this.lazy().sort(by, options).collect();
  }

  /** Joins with `other` on the key columns. */
  async join(other: LazyFrame | DataFrame, options: JoinOptions = {}): Promise<DataFrame> {
    return this.lazy().join(other, options).collect();
  }

  /** Groups the rows by the key expressions; `agg` runs the query. */
  groupBy(...keys: Array<Nested<Operand>>): EagerGroupBy {
    return new EagerGroupBy(this.lazy().groupBy(...keys));
  }

  /** One row per element of the list columns. */
  async explode(...columns: ColumnsArg[]): Promise<DataFrame> {
    return this.lazy().explode(...columns).collect();
  }

  /** Struct columns replaced by one column per field. */
  async unnest(columns: ColumnsArg, options: { separator?: string } = {}): Promise<DataFrame> {
    return this.lazy().unnest(columns, options).collect();
  }

  /** Drops duplicate rows, comparing `subset` (default all columns). */
  async unique(options: UniqueOptions = {}): Promise<DataFrame> {
    return frameOps.unique(this.lazy(), options).collect();
  }

  /** Runs SQL against this frame, named `tableName` (default `self`). */
  async sql(query: string, options: { tableName?: string; params?: SqlParams } = {}): Promise<DataFrame> {
    return (await this.lazy().sql(query, options)).collect();
  }

  /** Fills nulls with `value`, or with a strategy. */
  async fillNull(options: FillNullOptions): Promise<DataFrame> {
    return frameOps.fillNull(this.lazy(), options).collect();
  }

  /** Replaces NaN with `value` in the float columns. */
  async fillNan(value: Operand, subset?: Subset): Promise<DataFrame> {
    return frameOps.fillNan(this.lazy(), value, subset).collect();
  }

  /** Keeps the rows where the columns (default all) are not null. */
  async dropNulls(subset?: Subset): Promise<DataFrame> {
    return frameOps.dropNulls(this.lazy(), subset).collect();
  }

  /** Drops rows with NaN in the float columns. */
  async dropNans(subset?: Subset): Promise<DataFrame> {
    return frameOps.dropNans(this.lazy(), subset).collect();
  }

  /** Random rows: exactly `n` (or `fraction` of them); the same seed gives the same rows. */
  async sample(options: SampleOptions): Promise<DataFrame> {
    return (await frameOps.sample(this.lazy(), options)).collect();
  }

  /** Adds a row number as the first column. */
  async withRowIndex(options: RowIndexOptions = {}): Promise<DataFrame> {
    return frameOps.withRowIndex(this.lazy(), options).collect();
  }

  /** Stacks frames matching the columns by name. */
  async unionByName(...others: Array<LazyFrame | DataFrame>): Promise<DataFrame> {
    return frameOps.unionByName(this.lazy(), ...others).collect();
  }

  /** Summary statistics as text, one row per statistic. */
  async describe(): Promise<DataFrame> {
    return frameOps.describe(this);
  }

  /** Alias of `describe`. */
  async summary(): Promise<DataFrame> {
    return frameOps.describe(this);
  }

  /** Writes a Delta table (a path or object store URL). */
  async writeDelta(path: string, options: SinkDeltaOptions = {}): Promise<void> {
    await this.lazy().sinkDelta(path, options);
  }

  /** Writes a Parquet file (a local path or object store URL). */
  writeParquet(
    path: string,
    options: { compression?: string; rowGroupSize?: number; storageOptions?: StorageOptions } = {},
  ): Promise<void> {
    return this._df.writeParquet(
      path,
      options.compression ?? "zstd",
      options.rowGroupSize ?? null,
      normalizeStorageOptions(options.storageOptions),
    );
  }

  /** Writes a CSV file. */
  writeCsv(
    path: string,
    options: { separator?: string; includeHeader?: boolean; storageOptions?: StorageOptions } = {},
  ): Promise<void> {
    return this._df.writeCsv(
      path,
      options.includeHeader ?? true,
      options.separator ?? ",",
      normalizeStorageOptions(options.storageOptions),
    );
  }

  /** Writes one JSON object per row. */
  async writeNdjson(path: string, options: { storageOptions?: StorageOptions } = {}): Promise<void> {
    return this._df.writeNdjson(path, normalizeStorageOptions(options.storageOptions));
  }
}
