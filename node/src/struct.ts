import { JsExpr, type JsLazyFrame } from "../native/index.js";
import {
  branch,
  Expr,
  namedExpr,
  splitItems,
  toColumnExpr,
  toExpr,
  type Operand,
  type SelectItem,
} from "./expr.js";

/** A struct of the given expressions; fields are named like the expressions, or by key in a trailing object. */
export function struct(...items: SelectItem[]): Expr {
  const { positional, named } = splitItems(items);
  const pairs: Array<[string, Expr]> = [];
  for (const item of positional) {
    if (item instanceof StructUnnest) throw new TypeError("struct() cannot take struct.unnest()");
    const e = toColumnExpr(item);
    pairs.push([namedExpr(e).outputName(), e]);
  }
  for (const [name, value] of named) pairs.push([name, toExpr(value)]);
  if (pairs.length === 0) throw new Error("struct() needs at least one expression");
  const seen = new Set<string>();
  for (const [name] of pairs) {
    if (seen.has(name)) throw new Error(`struct() has the field name '${name}' twice; alias one of the expressions`);
    seen.add(name);
  }
  return new Expr(JsExpr.func("struct_pack", pairs.flatMap(([name, e]) => [JsExpr.lit(name), e._e])));
}

/** What `col("s").struct.unnest()` returns: select and withColumns expand it into one column per field. */
export class StructUnnest {
  private readonly x: Expr;

  constructor(x: Expr) {
    this.x = x;
  }

  /** @internal The expressions of the fields, named after them. */
  expand(lf: JsLazyFrame): Expr[] {
    const fields = lf.structFields(this.x._e);
    if (fields === null) throw new TypeError("struct.unnest() needs a struct expression");
    return fields.map((f) => new StructNamespace(this.x).field(f).alias(f));
  }
}

/** Struct functions, `col("s").struct.field("a")`. */
export class StructNamespace {
  private readonly x: Expr;

  constructor(x: Expr) {
    this.x = x;
  }

  /** The field `name`; null where the struct is null. */
  field(name: string): Expr {
    return this.x._f("struct_extract", name);
  }

  /** The same fields under new names, in order. */
  renameFields(names: readonly string[]): Expr {
    if (names.length === 0) throw new Error("renameFields needs the new names");
    return this.x._f("struct_rename", ...names);
  }

  /** The struct with extra fields: expressions named by their output names, or named entries. */
  withFields(...items: SelectItem[]): Expr {
    const { positional, named } = splitItems(items);
    const pairs: Array<[string, Operand]> = [];
    for (const item of positional) {
      if (item instanceof StructUnnest) throw new TypeError("withFields() cannot take struct.unnest()");
      const e = toColumnExpr(item);
      pairs.push([namedExpr(e).outputName(), e]);
    }
    pairs.push(...named);
    return this.x._f("struct_insert", ...pairs.flatMap(([name, value]) => [name, value]));
  }

  /** Expands into one column per field, inside select or withColumns. */
  unnest(): StructUnnest {
    return new StructUnnest(this.x);
  }

  /** The struct as JSON text; a null struct is the text `null` (Polars). */
  jsonEncode(): Expr {
    return branch(this.x.isNull(), "null", this.x._f("to_json"));
  }
}
