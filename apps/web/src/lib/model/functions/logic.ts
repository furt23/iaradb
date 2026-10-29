/** Conditions and safe division. */

import { sql, type Parts } from "../parts";
import { bind, fail, merge, noText, variadic, type FnDef } from "./def";

export const LOGIC_FUNCTIONS: readonly FnDef[] = [
  {
    kind: "expr",
    name: "if_",
    signature: "if_(condition, then, else)",
    doc: 'One value when the condition holds and another when it does not. Example: sum(if_(orders.status == "paid", orders.total, 0))',
    check(call, cx) {
      const a = bind(call, { params: ["condition", "then", "else"], required: 3, positional: 3 });
      const parts = ["condition", "then", "else"].map((k) => ({ node: a[k], typed: cx.expr(a[k]) }));
      const [c, t, e] = parts.map((p) => p.typed.sql);
      return { ...merge(parts), sql: sql`CASE WHEN ${c} THEN ${t} ELSE ${e} END` };
    },
  },
  {
    kind: "expr",
    name: "divide",
    signature: "divide(a, b, alternate=None)",
    doc: "a / b, but an empty result (or `alternate`) when b is zero or empty, instead of an error. Example: divide(sum(orders.profit), sum(orders.total), alternate=0)",
    check(call, cx) {
      const a = bind(call, { params: ["a", "b", "alternate"], required: 2, positional: 3 });
      const parts = ["a", "b", "alternate"].filter((k) => k in a).map((k) => ({ node: a[k], typed: cx.expr(a[k]) }));
      parts.slice(0, 2).forEach((p) => noText(p.node, p.typed));
      const [num, den] = parts.map((p) => p.typed.sql);
      const alternate = parts[2]?.typed.sql ?? ["NULL"];
      return {
        ...merge(parts),
        // the divisor is written twice: one atom once the measure numbers them
        sql: sql`CASE WHEN (${den}) = 0 OR (${den}) IS NULL THEN ${alternate} ELSE CAST((${num}) AS DOUBLE) / (${den}) END`,
      };
    },
  },
  {
    kind: "expr",
    name: "switch",
    signature: "switch(condition1, value1, condition2, value2, ..., default=None)",
    doc: 'The value after the first condition that holds, else `default` (empty without one). Example: switch(sum(orders.total) > 1000, "high", sum(orders.total) > 100, "medium", default="low")',
    check(call, cx) {
      const { default: fallback } = variadic(call, ["default"]);
      const n = call.args.length;
      if (n < 2) fail(call, "switch() needs at least one condition and its value: switch(condition, value, default=other)");
      if (n % 2 !== 0) fail(call.args[n - 1], "switch() takes conditions and values in pairs: this condition has no value");
      const parts = [...call.args, ...(fallback ? [fallback] : [])].map((node) => ({ node, typed: cx.expr(node) }));
      let out: Parts = ["CASE"];
      for (let i = 0; i < n; i += 2) out = sql`${out} WHEN ${parts[i].typed.sql} THEN ${parts[i + 1].typed.sql}`;
      if (fallback) out = sql`${out} ELSE ${parts[n].typed.sql}`;
      return { ...merge(parts), sql: sql`${out} END` };
    },
  },
];
