/** The two functions that shape the model itself: `measure` (format and label) and `relate`. */

import type { Expr } from "../ast";
import type { Relationship } from "../types";
import type { NumberFormat } from "@/lib/dashboards/types";

import { conflict } from "../graph";
import { bind, fail, type FnDef } from "./def";

const STYLES = ["number", "currency", "percent"] as const;

function string(node: Expr, what: string): string {
  if (node.kind !== "str") fail(node, `${what} must be a string in quotes`);
  return node.value;
}

/** The number format `measure(...)` asks for, from its keyword options (all optional). */
function numberFormat(a: Record<string, Expr>): NumberFormat | undefined {
  const named = a.format ? string(a.format, "format") : undefined;
  if (named !== undefined && !(STYLES as readonly string[]).includes(named)) {
    fail(a.format, `format must be one of "number", "currency" or "percent", not "${named}"`);
  }

  let decimals: number | undefined;
  if (a.decimals) {
    if (a.decimals.kind !== "num" || !a.decimals.int || Number(a.decimals.value) > 10) fail(a.decimals, "decimals must be a whole number from 0 to 10");
    decimals = Number(a.decimals.value);
  }

  let compact: boolean | undefined;
  if (a.compact) {
    if (a.compact.kind !== "const" || typeof a.compact.value !== "boolean") fail(a.compact, "compact must be True or False");
    compact = a.compact.value;
  }

  // options without a format still describe a plain number
  const style = (named as NumberFormat["style"] | undefined) ?? (decimals !== undefined || compact !== undefined ? "number" : undefined);
  if (a.currency && style !== "currency") fail(a.currency, 'currency only applies to format="currency"');
  if (!style) return undefined;

  let currency: string | undefined;
  if (style === "currency") {
    currency = a.currency ? string(a.currency, "currency") : "BRL";
    if (!/^[A-Z]{3}$/.test(currency)) fail(a.currency ?? a.format, 'currency must be 3 uppercase letters, e.g. "USD"');
  }
  return { style, ...(decimals !== undefined && { decimals }), ...(currency && { currency }), ...(compact !== undefined && { compact }) };
}

export const MODEL_SHAPING_FUNCTIONS: readonly FnDef[] = [
  {
    kind: "assignment",
    name: "measure",
    signature: 'measure(expr, format="number"|"currency"|"percent", decimals=0..10, currency="BRL", compact=False, label="")',
    doc: 'A measure with a number format and a label. Writing `name = sum(...)` alone is a measure too, without them. A percent of 0.25 shows as 25%. Example: revenue = measure(sum(orders.total), format="currency", label="Revenue")',
    check(call, cx) {
      const a = bind(call, { params: ["expr", "format", "decimals", "currency", "compact", "label"], required: 1, positional: 1 });
      const inner = cx.expr(a.expr);
      if (inner.level === "row") fail(a.expr, `\`${inner.bare?.text}\` must be inside an aggregation, e.g. sum(${inner.bare?.text})`);
      if (inner.level === "scalar") fail(a.expr, "measure() needs an aggregation like sum(orders.total); a fixed value is a constant, write `name = value`");
      const format = numberFormat(a);
      const label = a.label ? string(a.label, "label") : undefined;
      return { ...inner, ...(format && { format }), ...(label !== undefined && { label }) };
    },
  },
  {
    kind: "statement",
    name: "relate",
    signature: "relate(many.column, one.column)",
    doc: "Says each row of the first column's dataset points at one row of the second's, the 'many' side first. Used to join datasets: a chart can group by a column of the second dataset. The relationships must not form a cycle or give two datasets more than one path. Example: relate(orders.customer_id, customers.id)",
    check(call, cx): Relationship {
      const a = bind(call, { params: ["many", "one"], required: 2, positional: 2 });
      const many = cx.column(a.many);
      const one = cx.column(a.one);
      if (many.dataset === one.dataset) fail(a.one, `relate() needs columns of two different datasets, both are in ${many.dataset}`);
      const same = (x: typeof many, y: typeof many) => x.dataset === y.dataset && x.column === y.column;
      for (const r of cx.relationships) {
        if (same(r.many, many) && same(r.one, one)) fail(call, `this relationship is already defined on line ${r.span.line}`);
        if (same(r.many, one) && same(r.one, many)) fail(call, `this is the reverse of the relationship on line ${r.span.line}`);
      }
      const rel = { many, one, span: call.span };
      const why = conflict(cx.relationships, rel);
      if (why) fail(call, why);
      return rel;
    },
  },
];
