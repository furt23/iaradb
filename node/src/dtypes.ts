/** Data type names for casts and schemas, spelled as the engine spells them. */

export const Boolean = "bool";
export const Int8 = "int8";
export const Int16 = "int16";
export const Int32 = "int32";
export const Int64 = "int64";
export const UInt8 = "uint8";
export const UInt16 = "uint16";
export const UInt32 = "uint32";
export const UInt64 = "uint64";
export const Float32 = "float32";
export const Float64 = "float64";
export const Utf8 = "utf8";
export const String = "utf8";
export const Date = "date";
export const Datetime = "timestamp";

/** A decimal type with `precision` digits, `scale` of them after the point. */
export function Decimal(precision = 38, scale = 9): string {
  return `decimal(${precision},${scale})`;
}

function dtypeName(t: unknown): string {
  if (typeof t !== "string") {
    throw new TypeError(`a data type is a name such as 'int64' or Struct(..), not ${typeof t}`);
  }
  return t;
}

/** The type of lists of `inner`. */
export function List(inner: string): string {
  return `list<${dtypeName(inner)}>`;
}

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The type of structs: `Struct({ a: Int64, b: List(Utf8) })` or a list of `[name, type]` pairs. */
export function Struct(fields: Record<string, string> | ReadonlyArray<readonly [string, string]>): string {
  const items: ReadonlyArray<readonly [string, string]> = Array.isArray(fields)
    ? fields
    : Object.entries(fields);
  if (items.length === 0) throw new Error("a struct type needs at least one field");
  const parts = items.map(([name, type]) => {
    const n = PLAIN_NAME.test(name) ? name : `"${name}"`;
    return `${n}: ${dtypeName(type)}`;
  });
  return `struct<${parts.join(", ")}>`;
}
