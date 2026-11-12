import { branch, Expr } from "./expr.js";

/** String functions, `col("s").str.toUppercase()`. */
export class StrNamespace {
  private readonly x: Expr;

  constructor(x: Expr) {
    this.x = x;
  }

  /** True where the string contains `pattern` (a regex unless `literal`). */
  contains(pattern: string, literal = false): Expr {
    return literal ? this.x._f("contains", pattern) : this.x._f("regexp_like", pattern);
  }

  /** SQL LIKE match. */
  like(pattern: string, caseInsensitive = false): Expr {
    return new Expr(this.x._e.like(pattern, false, caseInsensitive));
  }

  /** True where the string starts with `prefix`. */
  startsWith(prefix: string): Expr {
    return this.x._f("starts_with", prefix);
  }

  /** True where the string ends with `suffix`. */
  endsWith(suffix: string): Expr {
    return this.x._f("ends_with", suffix);
  }

  /** Upper case. */
  toUppercase(): Expr {
    return this.x._f("upper");
  }

  /** Lower case. */
  toLowercase(): Expr {
    return this.x._f("lower");
  }

  /** Number of characters. */
  lenChars(): Expr {
    return this.x._f("length");
  }

  /** Number of bytes. */
  lenBytes(): Expr {
    return this.x._f("octet_length");
  }

  /** Removes whitespace at both ends. */
  stripChars(): Expr {
    return this.x._f("trim");
  }

  /** Removes whitespace at the start. */
  stripCharsStart(): Expr {
    return this.x._f("ltrim");
  }

  /** Removes whitespace at the end. */
  stripCharsEnd(): Expr {
    return this.x._f("rtrim");
  }

  /** `length` characters from the 0-based `offset`; to the end when no length. */
  slice(offset: number, length?: number | null): Expr {
    if (length === undefined || length === null) return this.x._f("substring", offset + 1);
    return this.x._f("substring", offset + 1, length);
  }

  /** The first `n` characters. */
  head(n: number): Expr {
    return this.x._f("left", n);
  }

  /** The last `n` characters. */
  tail(n: number): Expr {
    return this.x._f("right", n);
  }

  /** Replaces every match; `value` may use `$1` / `${name}` group references. */
  replaceAll(pattern: string, value: string, literal = false): Expr {
    return this.x._f("regexp_replace", pattern, value, (literal ? "l" : "") + "gr");
  }

  /** Replaces the first `n` matches (Polars); only n=1 or n<0 (all) are supported. */
  replace(pattern: string, value: string, options: { literal?: boolean; n?: number } = {}): Expr {
    const n = options.n ?? 1;
    const literal = options.literal ?? false;
    if (n < 0) return this.replaceAll(pattern, value, literal);
    if (n !== 1) throw new Error("str.replace supports n=1 or n=-1 (use replaceAll)");
    return this.x._f("regexp_replace", pattern, value, (literal ? "l" : "") + "r");
  }

  /** Capture group `groupIndex` of the first match; null when nothing matches. */
  extract(pattern: string, groupIndex = 1): Expr {
    return this.x._f("regexp_extract", pattern, groupIndex, "n");
  }

  /** Splits on the text `by` (not a regex) into a list of strings. */
  split(by: string, options: { inclusive?: boolean } = {}): Expr {
    if (options.inclusive) throw new Error("str.split(inclusive=true) is not supported");
    return this.x._f("string_split", by);
  }

  /** Number of non-overlapping matches. */
  countMatches(pattern: string, literal = false): Expr {
    return this.x._f("regexp_count", pattern, literal ? "l" : "");
  }

  /** Parses to a date with the strptime `format`; `strict` false gives null on failure. */
  toDate(format?: string, options: { strict?: boolean } = {}): Expr {
    if (format === undefined) return new Expr(this.x._e.cast("date", true));
    return this.x._f((options.strict ?? true) ? "strptime_date" : "to_date", format);
  }

  /** Parses to a timestamp with the strptime `format`; `strict` false gives null on failure. */
  toDatetime(format?: string, options: { strict?: boolean } = {}): Expr {
    if (format === undefined) return new Expr(this.x._e.cast("timestamp", true));
    return this.x._f((options.strict ?? true) ? "strptime" : "to_timestamp", format);
  }

  /** Left-pads to `length` characters; longer strings are kept whole (Polars). */
  padStart(length: number, fillChar = " "): Expr {
    return branch(this.lenChars().gte(length), this.x, this.x._f("lpad", length, fillChar));
  }

  /** Right-pads to `length` characters; longer strings are kept whole (Polars). */
  padEnd(length: number, fillChar = " "): Expr {
    return branch(this.lenChars().gte(length), this.x, this.x._f("rpad", length, fillChar));
  }

  /** Left-pads with zeros, keeping a leading sign in front. */
  zfill(length: number): Expr {
    return this.x._f("zfill", length);
  }

  /** Capitalises each word. */
  toTitlecase(): Expr {
    return this.x._f("initcap");
  }

  /** Parses JSON text into `dtype` (a `Struct(...)`, `List(...)` or scalar type name); required, as the plan is typed up front. */
  jsonDecode(dtype: string): Expr {
    if (typeof dtype !== "string" || dtype === "") {
      throw new TypeError("str.jsonDecode needs a dtype, e.g. Struct({ a: Int64, tags: List(Utf8) })");
    }
    return this.x._f("from_json", dtype);
  }

  /** The value at `jsonPath` (`$.a.b[0]`) as a string; null when absent. */
  jsonPathMatch(jsonPath: string): Expr {
    return this.x._f("json_extract_string", jsonPath);
  }

  /** Reverses the characters. */
  reverse(): Expr {
    return this.x._f("reverse");
  }
}
