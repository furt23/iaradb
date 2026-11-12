import type * as arrow from "apache-arrow";
import { JsSessionContext } from "../native/index.js";
import { DataFrame } from "./dataframe.js";
import { fromArrow } from "./convert.js";
import { LazyFrame } from "./lazyframe.js";
import { csvOptions, isJsonPath, jsonOptions, type CsvOptions, type JsonOptions } from "./io.js";
import { normalizeStorageOptions, type StorageOptions } from "./runtime.js";

/** A frame that can be registered as a table. A string is a file path (.csv, .json/.ndjson or Parquet). */
export type Source = LazyFrame | DataFrame | arrow.Table | string;

/** Bound values of a query: positional (`$1`, `?`) or named (`:name`, `$name`). */
export type SqlParams = readonly unknown[] | Record<string, unknown>;

let defaultNative: JsSessionContext | undefined;

/** The session that `scanParquet`, `DataFrame.lazy()` and the other top-level readers use. */
export function defaultSession(): JsSessionContext {
  defaultNative ??= new JsSessionContext();
  return defaultNative;
}

/** Named tables and their catalogs, queried with SQL or the frame API. */
export class SessionContext {
  private native: JsSessionContext;

  /** `defaultCatalog`: the catalog that registrations belong to (`main` when not given). */
  constructor(defaultCatalog?: string) {
    this.native = new JsSessionContext(defaultCatalog);
  }

  /** Registers a frame, a table or a file path under `name`. */
  async register(name: string, frame: Source): Promise<void> {
    if (frame instanceof LazyFrame) {
      this.native.registerLazy(name, frame._lf);
    } else if (frame instanceof DataFrame) {
      this.native.registerDataframe(name, frame._df);
    } else if (typeof frame === "string") {
      if (frame.toLowerCase().endsWith(".csv")) await this.registerCsv(name, frame);
      else if (isJsonPath(frame)) await this.registerJson(name, frame);
      else await this.registerParquet(name, frame);
    } else {
      this.native.registerDataframe(name, (await fromArrow(frame))._df);
    }
  }

  /** Registers Parquet files (a path, directory, glob or URL); `lazy` lists them on first use. */
  async registerParquet(name: string, path: string, options: { storageOptions?: StorageOptions; lazy?: boolean } = {}): Promise<void> {
    return this.native.registerParquet(name, path, normalizeStorageOptions(options.storageOptions), options.lazy ?? false);
  }

  /** Registers a folder of Parquet files or a Delta table; the kind is detected when the table loads. */
  async registerTable(name: string, path: string, options: { storageOptions?: StorageOptions; lazy?: boolean } = {}): Promise<void> {
    return this.native.registerTable(name, path, normalizeStorageOptions(options.storageOptions), options.lazy ?? false);
  }

  /** Registers a Delta table at its newest version. */
  async registerDelta(name: string, path: string, options: { storageOptions?: StorageOptions; lazy?: boolean } = {}): Promise<void> {
    return this.native.registerDelta(name, path, normalizeStorageOptions(options.storageOptions), options.lazy ?? false);
  }

  /** Registers CSV files; the CSV options are those of `scanCsv`. */
  async registerCsv(name: string, path: string, options: CsvOptions & { hasHeader?: boolean; separator?: string; storageOptions?: StorageOptions; lazy?: boolean } = {}): Promise<void> {
    return this.native.registerCsv(
      name,
      path,
      options.hasHeader ?? true,
      options.separator ?? ",",
      10000,
      true,
      normalizeStorageOptions(options.storageOptions),
      options.lazy ?? false,
      csvOptions(options),
    );
  }

  /** Registers JSON or NDJSON files (a path, folder, glob or URL). */
  async registerJson(name: string, path: string, options: JsonOptions & { storageOptions?: StorageOptions; lazy?: boolean } = {}): Promise<void> {
    return this.native.registerJson(
      name,
      path,
      jsonOptions(options),
      normalizeStorageOptions(options.storageOptions),
      options.lazy ?? false,
    );
  }

  /** False while a lazily registered table has not been read yet; null for an unknown name. */
  isLoaded(name: string): boolean | null {
    return this.native.isLoaded(name);
  }

  /** Removes a registered table; false when there was none. */
  deregister(name: string): boolean {
    return this.native.deregister(name);
  }

  /** A new session starting with this one's tables; later registrations on either side are independent. */
  fork(): SessionContext {
    const child = new SessionContext();
    child.native = this.native.fork();
    return child;
  }

  /** Where `CREATE TABLE ... AS` writes tables (null: in memory). */
  setWarehouse(path: string | null, options: { storageOptions?: StorageOptions } = {}): void {
    this.native.setWarehouse(path, normalizeStorageOptions(options.storageOptions));
  }

  /** The warehouse path, or null when created tables stay in memory. */
  get warehouse(): string | null {
    return this.native.warehouse();
  }

  /** Table names: bare for `main` in the default catalog, `schema.table` for the others. */
  tables(): string[] {
    return this.native.tables();
  }

  /** Catalog names: the default one first, then the others sorted. */
  catalogs(): string[] {
    return this.native.catalogs();
  }

  /** The catalog that two-part names refer to; `USE CATALOG` sets it. */
  currentCatalog(): string {
    return this.native.currentCatalog();
  }

  /** The catalog that registrations and `table()` names are relative to. */
  defaultCatalog(): string {
    return this.native.defaultCatalog();
  }

  /** Schema names of `catalog` (the current one when not given), `main` first. */
  schemas(catalog?: string): string[] {
    return this.native.schemas(catalog ?? null);
  }

  /** The schema a bare table name is looked up in first; `USE` sets it. */
  currentSchema(): string {
    return this.native.currentSchema();
  }

  /** A registered table by its name, relative to the default catalog. */
  async table(name: string): Promise<LazyFrame> {
    return new LazyFrame(await this.native.table(name));
  }

  /** Runs SQL; `params` binds `$1`, `$2` / `?` (an array) or `:name` / `$name` (an object). */
  async sql(query: string, params?: SqlParams): Promise<LazyFrame> {
    return new LazyFrame(await this.native.sql(query, params));
  }

  /** A lazy scan of Parquet files. */
  async readParquet(path: string, options: { storageOptions?: StorageOptions } = {}): Promise<LazyFrame> {
    return new LazyFrame(await this.native.readParquet(path, normalizeStorageOptions(options.storageOptions)));
  }

  /** A lazy read of a Delta table; `timestamp` is a Date or milliseconds since the epoch. */
  async readDelta(
    path: string,
    options: { version?: number; timestamp?: number | Date; storageOptions?: StorageOptions } = {},
  ): Promise<LazyFrame> {
    return new LazyFrame(
      await this.native.readDelta(
        path,
        options.version ?? null,
        deltaMillis(options.timestamp),
        normalizeStorageOptions(options.storageOptions),
      ),
    );
  }

  /** A lazy scan of CSV files. */
  async readCsv(path: string, options: CsvOptions & { hasHeader?: boolean; separator?: string; storageOptions?: StorageOptions } = {}): Promise<LazyFrame> {
    return new LazyFrame(
      await this.native.readCsv(
        path,
        options.hasHeader ?? true,
        options.separator ?? ",",
        10000,
        true,
        normalizeStorageOptions(options.storageOptions),
        csvOptions(options),
      ),
    );
  }

  /** A lazy scan of JSON or NDJSON files. */
  async readJson(path: string, options: JsonOptions & { storageOptions?: StorageOptions } = {}): Promise<LazyFrame> {
    return new LazyFrame(
      await this.native.readJson(path, jsonOptions(options), normalizeStorageOptions(options.storageOptions)),
    );
  }

  /** A frame from an Arrow table, as a lazy frame. */
  async fromArrow(table: arrow.Table): Promise<LazyFrame> {
    const df = await fromArrow(table);
    return new LazyFrame(this.native.fromDataframe(df._df));
  }
}

/** Milliseconds since the epoch for a time travel timestamp; a whole number of milliseconds. */
export function deltaMillis(timestamp: number | Date | undefined): number | null {
  if (timestamp === undefined) return null;
  if (timestamp instanceof Date) {
    if (Number.isNaN(timestamp.getTime())) throw new TypeError("timestamp is an invalid Date");
    return timestamp.getTime();
  }
  if (!Number.isInteger(timestamp)) {
    throw new TypeError("timestamp must be a Date or a whole number of milliseconds since the epoch");
  }
  return timestamp;
}

/** Runs SQL over the given tables, which are named in `options.tables`. */
export async function sql(
  query: string,
  options: { params?: SqlParams; tables?: Record<string, Source> } = {},
): Promise<LazyFrame> {
  const ctx = new SessionContext();
  for (const [name, frame] of Object.entries(options.tables ?? {})) await ctx.register(name, frame);
  return ctx.sql(query, options.params);
}
