import * as arrow from "apache-arrow";
import { JsDataFrame } from "../native/index.js";
import { DataFrame } from "./dataframe.js";
import { isPlainObject } from "./expr.js";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
/** Integers at or above this magnitude do not fit int64; they stay floats. */
const INT64_BOUND = 2 ** 63;

/** An int64 value as a number when it is safe to, else as a bigint. */
function intValue(v: bigint): number | bigint {
  return v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : v;
}

/** A decimal from its little-endian 32-bit words (two's complement), with the point placed by `scale`. */
export function formatDecimal(words: ArrayLike<number>, scale: number): string {
  const bits = BigInt(words.length * 32);
  let raw = 0n;
  for (let k = words.length - 1; k >= 0; k--) raw = (raw << 32n) | BigInt(words[k]);
  if (((raw >> (bits - 1n)) & 1n) === 1n) raw -= 1n << bits;
  const negative = raw < 0n;
  let digits = (negative ? -raw : raw).toString();
  let body: string;
  if (scale > 0) {
    digits = digits.padStart(scale + 1, "0");
    body = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  } else {
    body = digits + "0".repeat(-scale);
  }
  return (negative ? "-" : "") + body;
}

/** The plain JS value at row `i` of an Arrow vector. */
function readValue(vec: arrow.Vector, i: number): unknown {
  const value: unknown = vec.get(i);
  if (value === null || value === undefined) return null;
  // every 64-bit type comes back as a bigint (int64, time, duration ...)
  if (typeof value === "bigint" && vec.type.typeId !== arrow.Type.Timestamp) return intValue(value);
  switch (vec.type.typeId) {
    case arrow.Type.Date:
    case arrow.Type.Timestamp:
      // arrow-js hands dates and timestamps back as milliseconds since the epoch
      return new Date(Number(value));
    case arrow.Type.Decimal:
      return formatDecimal(value as ArrayLike<number>, (vec.type as arrow.Decimal).scale);
    case arrow.Type.List:
    case arrow.Type.FixedSizeList: {
      const items = value as arrow.Vector;
      return Array.from({ length: items.length }, (_, j) => readValue(items, j));
    }
    case arrow.Type.Struct: {
      const out: Record<string, unknown> = {};
      (vec.type as arrow.Struct).children.forEach((field, k) => {
        const child = vec.getChildAt(k);
        out[field.name] = child === null ? null : readValue(child, i);
      });
      return out;
    }
    default:
      return value;
  }
}

function readColumn(vec: arrow.Vector): unknown[] {
  return Array.from({ length: vec.length }, (_, i) => readValue(vec, i));
}

function columnsOf(table: arrow.Table): Array<[string, unknown[]]> {
  return table.schema.fields.map((field, k) => {
    const vec = table.getChildAt(k);
    return [field.name, vec === null ? [] : readColumn(vec)];
  });
}

/** A table as one plain object per row. */
export function tableToRecords(table: arrow.Table): Record<string, unknown>[] {
  const cols = columnsOf(table);
  return Array.from({ length: table.numRows }, (_, i) =>
    Object.fromEntries(cols.map(([name, values]) => [name, values[i]])),
  );
}

/** A table as one array of values per column, by name. */
export function tableToColumns(table: arrow.Table): Record<string, unknown[]> {
  return Object.fromEntries(columnsOf(table));
}

/** A table as one array of values per row, in column order. */
export function tableToRows(table: arrow.Table): unknown[][] {
  const cols = columnsOf(table);
  return Array.from({ length: table.numRows }, (_, i) => cols.map(([, values]) => values[i]));
}

type Kind = "number" | "bigint" | "boolean" | "string" | "Date" | "bytes" | "list" | "object";

function kindOf(v: unknown, name: string): Kind {
  if (typeof v === "number") return "number";
  if (typeof v === "bigint") return "bigint";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return "string";
  if (v instanceof Date) return "Date";
  if (v instanceof Uint8Array) return "bytes";
  if (Array.isArray(v)) return "list";
  if (isPlainObject(v)) return "object";
  throw new TypeError(`column "${name}" has a value of unsupported type ${typeof v}`);
}

/** The Arrow type of a column of JS values; nested lists and objects take their types from their contents. */
function inferType(name: string, values: readonly unknown[]): arrow.DataType {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (present.length === 0) return new arrow.Null();
  const kinds = new Set(present.map((v) => kindOf(v, name)));
  if ([...kinds].every((k) => k === "number" || k === "bigint")) {
    const integral = present.every(
      (v) => typeof v === "bigint" || (typeof v === "number" && Number.isInteger(v) && Math.abs(v) < INT64_BOUND),
    );
    if (integral) return new arrow.Int64();
    if (kinds.has("bigint")) throw new TypeError(`column "${name}" mixes integers and non-integer numbers`);
    return new arrow.Float64();
  }
  if (kinds.size > 1) throw new TypeError(`column "${name}" mixes ${[...kinds].join(" and ")} values`);
  const [kind] = kinds;
  switch (kind) {
    case "boolean":
      return new arrow.Bool();
    case "string":
      return new arrow.Utf8();
    case "Date":
      if (present.some((d) => Number.isNaN((d as Date).getTime()))) {
        throw new TypeError(`column "${name}" has an invalid Date`);
      }
      return new arrow.TimestampMillisecond();
    case "bytes":
      return new arrow.Binary();
    case "list": {
      const child = inferType(`${name}[]`, present.flatMap((v) => v as unknown[]));
      return new arrow.List(new arrow.Field("item", child, true));
    }
    default: {
      const keys: string[] = [];
      const seen = new Set<string>();
      for (const o of present) {
        for (const key of Object.keys(o as object)) {
          if (!seen.has(key)) {
            seen.add(key);
            keys.push(key);
          }
        }
      }
      const fields = keys.map(
        (key) =>
          new arrow.Field(
            key,
            inferType(
              `${name}.${key}`,
              present.map((o) => (o as Record<string, unknown>)[key]),
            ),
            true,
          ),
      );
      return new arrow.Struct(fields);
    }
  }
}

/** A value in the form the Arrow builder of `type` takes (int64 wants bigints, nested values convert too). */
function toArrowValue(v: unknown, type: arrow.DataType): unknown {
  if (v === null || v === undefined) return null;
  switch (type.typeId) {
    case arrow.Type.Int:
      return typeof v === "number" ? BigInt(v) : v;
    case arrow.Type.List: {
      const child = (type as arrow.List).children[0].type;
      return (v as unknown[]).map((e) => toArrowValue(e, child));
    }
    case arrow.Type.Struct:
      return Object.fromEntries(
        (type as arrow.Struct).children.map((f) => [
          f.name,
          toArrowValue((v as Record<string, unknown>)[f.name], f.type),
        ]),
      );
    default:
      return v;
  }
}

function buildVector(name: string, values: readonly unknown[]): arrow.Vector {
  const type = inferType(name, values);
  return arrow.vectorFromArray(
    values.map((v) => toArrowValue(v, type)),
    type,
  );
}

/** A table from columns of JS values, typed by their contents. */
export function columnsToTable(columns: Record<string, readonly unknown[]>): arrow.Table {
  const entries = Object.entries(columns);
  for (const [name, values] of entries) {
    if (!Array.isArray(values)) throw new TypeError(`column "${name}" must be an array of values`);
  }
  if (new Set(entries.map(([, values]) => values.length)).size > 1) {
    throw new Error("every column needs the same number of values");
  }
  const vectors: Record<string, arrow.Vector> = {};
  for (const [name, values] of entries) vectors[name] = buildVector(name, values);
  return new arrow.Table(vectors);
}

/** A table from rows: the columns are the keys of all rows, in first-seen order; a missing key is null. */
export function recordsToTable(rows: readonly Record<string, unknown>[]): arrow.Table {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isPlainObject(row)) throw new TypeError("fromRecords expects an array of plain objects");
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        names.push(key);
      }
    }
  }
  const columns: Record<string, unknown[]> = {};
  for (const name of names) columns[name] = rows.map((row) => row[name]);
  return columnsToTable(columns);
}

/** A DataFrame from an Arrow table. */
export async function fromArrow(table: arrow.Table): Promise<DataFrame> {
  return new DataFrame(await JsDataFrame.fromIpc(arrow.tableToIPC(table, "stream")));
}

/** A DataFrame from rows of plain objects (`toRecords` reads them back). */
export async function fromRecords(rows: readonly Record<string, unknown>[]): Promise<DataFrame> {
  return fromArrow(recordsToTable(rows));
}

/** A DataFrame from one array of values per column name. */
export async function fromColumns(columns: Record<string, readonly unknown[]>): Promise<DataFrame> {
  return fromArrow(columnsToTable(columns));
}
