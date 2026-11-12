import { branch, Expr, type Operand } from "./expr.js";

/** A slice end past any list. */
const END = 2 ** 62;

/** List functions, following Polars (indexes are 0-based here). */
export class ListNamespace {
  private readonly x: Expr;

  constructor(x: Expr) {
    this.x = x;
  }

  private f(name: string, ...args: Operand[]): Expr {
    return this.x._f(name, ...args);
  }

  /** Number of elements (null for a null list). */
  len(): Expr {
    return this.f("array_length");
  }

  /** The element at `index` (0-based; negative counts from the end); null when out of range. */
  get(index: number | Expr): Expr {
    if (typeof index === "number") return this.f("list_extract", index >= 0 ? index + 1 : index);
    return this.f("list_extract", branch(index.gte(0), index.plus(1), index));
  }

  /** The first element. */
  first(): Expr {
    return this.get(0);
  }

  /** The last element. */
  last(): Expr {
    return this.get(-1);
  }

  /** `length` elements from the 0-based `offset` (a negative offset counts from the end). */
  slice(offset: number, length?: number | null): Expr {
    const hasLength = length !== undefined && length !== null;
    if (offset >= 0) {
      const end = hasLength ? offset + length : END;
      return this.f("list_slice", offset + 1, end);
    }
    if (!hasLength || offset + length >= 0) return this.f("list_slice", offset, END);
    return this.f("list_slice", offset, offset + length - 1);
  }

  /** The first `n` elements. */
  head(n = 5): Expr {
    return this.slice(0, n);
  }

  /** The last `n` elements. */
  tail(n = 5): Expr {
    return this.slice(-n, n);
  }

  /** True where the list holds `item`. */
  contains(item: Operand): Expr {
    return this.f("list_contains", item);
  }

  /** Sorts every list (nulls first unless `nullsLast`, as Polars). */
  sort(options: { descending?: boolean; nullsLast?: boolean } = {}): Expr {
    return this.f(
      "list_sort",
      options.descending ? "DESC" : "ASC",
      options.nullsLast ? "NULLS LAST" : "NULLS FIRST",
    );
  }

  /** Reverses every list. */
  reverse(): Expr {
    return this.f("list_reverse");
  }

  /** The distinct elements, a null included, in first-seen order. */
  unique(): Expr {
    return this.f("list_distinct", "keep_nulls");
  }

  /** Number of distinct elements, a null counting as one. */
  nUnique(): Expr {
    return new ListNamespace(this.unique()).len();
  }

  private reduce(name: string, empty?: number): Expr {
    const r = this.f(name);
    if (empty === undefined) return r;
    return branch(this.x.isNull(), null, r.fillNull(empty));
  }

  /** Sum of the non-null elements (0 for an empty list). */
  sum(): Expr {
    return this.reduce("list_sum", 0);
  }

  /** Smallest element. */
  min(): Expr {
    return this.reduce("list_min");
  }

  /** Largest element. */
  max(): Expr {
    return this.reduce("list_max");
  }

  /** Mean of the non-null elements. */
  mean(): Expr {
    return this.reduce("list_avg");
  }

  /** Median of the non-null elements. */
  median(): Expr {
    return this.reduce("list_median");
  }

  /** The elements joined as text; a null element makes the result null unless `ignoreNulls`. */
  join(separator: string, options: { ignoreNulls?: boolean } = {}): Expr {
    const joined = this.f("array_to_string", separator);
    if (options.ignoreNulls ?? true) {
      // a list of only nulls joins to '' (the engine's SQL function gives NULL)
      return branch(this.x.isNull(), null, joined.fillNull(""));
    }
    const hasNull = this.f("array_length").neq(this.f("list_count"));
    return branch(hasNull, null, joined);
  }
}
