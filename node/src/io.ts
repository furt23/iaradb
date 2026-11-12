import { DataFrame } from "./dataframe.js";
import { LazyFrame } from "./lazyframe.js";
import { defaultSession, deltaMillis } from "./session.js";
import { normalizeStorageOptions, type StorageOptions } from "./runtime.js";

/** Read options of CSV files, with Polars' names. */
export interface CsvOptions {
  /** `null` reads without quotes; default `"`. */
  quoteChar?: string | null;
  /** The escape character (DuckDB). */
  escape?: string;
  /** Strings read as null, besides the empty string. */
  nullValues?: string | readonly string[];
  skipRows?: number;
  comment?: string;
  /** Polars' name for `comment`. */
  commentPrefix?: string;
  /** The names of the columns to keep, in this order. */
  columns?: readonly string[];
  /** Column types, by name (`"int64"`, ...). */
  schemaOverrides?: Record<string, string>;
  /** Polars' name for `schemaOverrides`. */
  dtypes?: Record<string, string>;
  /** `"utf8"` (default) or `"utf8-lossy"`. */
  encoding?: string;
  /** Whether dates are inferred (default true; false keeps them as text). */
  tryParseDates?: boolean;
}

/** Read options of JSON and NDJSON files. */
export interface JsonOptions {
  inferSchemaLength?: number;
  parallel?: boolean;
  /** `"auto"` (by each file's first byte), `"ndjson"` or `"array"`. */
  format?: "auto" | "ndjson" | "array";
  /** `"auto"` reads objects and arrays as struct and list columns; `"text"` as JSON text. */
  nested?: "auto" | "text";
}

export interface ScanCsvOptions extends CsvOptions {
  hasHeader?: boolean;
  separator?: string;
  inferSchemaLength?: number;
  parallel?: boolean;
  storageOptions?: StorageOptions;
}

export interface ScanJsonOptions extends JsonOptions {
  storageOptions?: StorageOptions;
}

/** The engine's option object for the CSV options given. */
export function csvOptions(options: CsvOptions): Record<string, unknown> {
  const quote = options.quoteChar === undefined ? '"' : (options.quoteChar ?? "");
  const out: Record<string, unknown> = {
    quote,
    encoding: options.encoding ?? "utf8",
    try_parse_dates: options.tryParseDates ?? true,
  };
  if (options.escape) out.escape = options.escape;
  const comment = options.comment || options.commentPrefix;
  if (comment) out.comment = comment;
  if (options.nullValues !== undefined) {
    out.null_values = typeof options.nullValues === "string" ? [options.nullValues] : [...options.nullValues];
  }
  if (options.skipRows) out.skip_rows = options.skipRows;
  if (options.columns !== undefined) out.columns = [...options.columns];
  const types = { ...options.dtypes, ...options.schemaOverrides };
  if (Object.keys(types).length > 0) out.schema_overrides = types;
  return out;
}

/** The engine's option object for the JSON options given (`format` is "auto" when not given). */
export function jsonOptions(options: JsonOptions): Record<string, unknown> {
  return {
    infer_rows: options.inferSchemaLength ?? 1000,
    parallel: options.parallel ?? true,
    format: options.format ?? "auto",
    nested: options.nested ?? "auto",
  };
}

/** Whether a path has a JSON or NDJSON extension. */
export function isJsonPath(path: string): boolean {
  return [".json", ".ndjson", ".jsonl"].some((ext) => path.toLowerCase().endsWith(ext));
}

/** A lazy scan of Parquet files (a path, directory, glob or URL). */
export async function scanParquet(path: string, options: { storageOptions?: StorageOptions } = {}): Promise<LazyFrame> {
  return new LazyFrame(await defaultSession().readParquet(path, normalizeStorageOptions(options.storageOptions)));
}

/** A lazy scan of a Delta table; `version` or `timestamp` reads an older state. */
export async function scanDelta(
  path: string,
  options: { version?: number; timestamp?: number | Date; storageOptions?: StorageOptions } = {},
): Promise<LazyFrame> {
  return new LazyFrame(
    await defaultSession().readDelta(
      path,
      options.version ?? null,
      deltaMillis(options.timestamp),
      normalizeStorageOptions(options.storageOptions),
    ),
  );
}

/** A lazy scan of CSV files (a path, folder, glob or URL). */
export async function scanCsv(path: string, options: ScanCsvOptions = {}): Promise<LazyFrame> {
  return new LazyFrame(
    await defaultSession().readCsv(
      path,
      options.hasHeader ?? true,
      options.separator ?? ",",
      options.inferSchemaLength ?? 10000,
      options.parallel ?? true,
      normalizeStorageOptions(options.storageOptions),
      csvOptions(options),
    ),
  );
}

/** A lazy scan of newline-delimited JSON (`.ndjson`, `.jsonl`, `.json`); the schema comes from the first records. */
export async function scanNdjson(path: string, options: ScanJsonOptions = {}): Promise<LazyFrame> {
  return new LazyFrame(
    await defaultSession().readJson(
      path,
      jsonOptions({ ...options, format: options.format ?? "ndjson" }),
      normalizeStorageOptions(options.storageOptions),
    ),
  );
}

/** Like `scanNdjson`, but a file holding one JSON array of objects is read too (`format` "auto"). */
export async function scanJson(path: string, options: ScanJsonOptions = {}): Promise<LazyFrame> {
  return new LazyFrame(
    await defaultSession().readJson(path, jsonOptions(options), normalizeStorageOptions(options.storageOptions)),
  );
}

/** Reads Parquet into a DataFrame. */
export async function readParquet(path: string, options: { storageOptions?: StorageOptions } = {}): Promise<DataFrame> {
  return (await scanParquet(path, options)).collect();
}

/** Reads a Delta table into a DataFrame. */
export async function readDelta(
  path: string,
  options: { version?: number; timestamp?: number | Date; storageOptions?: StorageOptions } = {},
): Promise<DataFrame> {
  return (await scanDelta(path, options)).collect();
}

/** Reads CSV files into a DataFrame. */
export async function readCsv(path: string, options: ScanCsvOptions = {}): Promise<DataFrame> {
  return (await scanCsv(path, options)).collect();
}

/** Reads NDJSON files into a DataFrame. */
export async function readNdjson(path: string, options: ScanJsonOptions = {}): Promise<DataFrame> {
  return (await scanNdjson(path, options)).collect();
}

/** Reads JSON or NDJSON files into a DataFrame. */
export async function readJson(path: string, options: ScanJsonOptions = {}): Promise<DataFrame> {
  return (await scanJson(path, options)).collect();
}
