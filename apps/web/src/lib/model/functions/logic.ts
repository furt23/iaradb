/** Conditions and safe division. */

import { sql } from "../parts";
import { bind, merge, noText, type FnDef } from "./def";

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
];
