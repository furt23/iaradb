/**
 * `calculate` changes the filter context of a measure: it adds conditions on
 * one dataset's rows and, with `all_`, takes filters away. The change is
 * written on each atom of the measure (`Atom.context`), for the compiler.
 */

import { attrs, type Call, type Expr } from "../ast";
import { reachable } from "../graph";
import { hasRank, mapAtoms, text } from "../parts";
import type { AtomContext } from "../types";
import { fail, list, needAggregate, variadic, type FnCx, type FnDef } from "./def";

type Removal = AtomContext["removed"][number];

/** a condition on the rows of one dataset, and the columns it reads */
interface Condition {
  node: Expr;
  dataset: string;
  sql: string;
  columns: string[];
}

/** `x + 1` or `"a"` is a value, not something rows can be filtered by */
const isValue = (n: Expr) =>
  n.kind === "num" || n.kind === "str" || (n.kind === "binary" && ["+", "-", "*", "/", "%"].includes(n.op)) || (n.kind === "unary" && n.op !== "not");

function condition(node: Expr, cx: FnCx): Condition {
  const t = cx.expr(node);
  if (t.level === "aggregate") fail(node, "a calculate() filter works on rows: it cannot use an aggregation or a measure");
  if (t.level === "scalar" || isValue(node)) fail(node, 'a calculate() filter is a condition on columns, e.g. orders.status == "paid"');
  if (t.datasets.length > 1) fail(node, `a calculate() filter reads one dataset: this one reads ${list(t.datasets)}`);
  const columns = [...new Set(attrs(node).map((a) => cx.column(a).column))];
  return { node, dataset: t.datasets[0], sql: text(t.sql), columns };
}

/** What `all_(...)` takes away: what it names, or with no arguments everything the aggregation reaches. */
function removals(call: Call, cx: FnCx): Removal[] | "everything" {
  variadic(call);
  if (call.args.length === 0) return "everything";
  return call.args.map((a) => {
    if (a.kind !== "attr") return { dataset: cx.dataset(a) };
    const { dataset, column } = cx.column(a);
    return { dataset, column };
  });
}

/** Is the filter on `column` of `dataset` already taken away (the column, or its whole dataset)? */
const covered = (removed: readonly Removal[], dataset: string, column: string) =>
  removed.some((r) => r.dataset === dataset && (r.column === undefined || r.column === column));

/**
 * `inner` (what an inner calculate already did) extended by the outer one.
 * The inner wins: an outer condition on a column the inner one already
 * filters or removes is dropped, with what it would remove. Removals add up.
 */
function extend(inner: AtomContext | undefined, conditions: readonly Condition[], removals: readonly Removal[]): AtomContext {
  const before = inner ?? { filters: [], removed: [] };
  const kept = conditions.filter((c) => !c.columns.some((col) => covered(before.removed, c.dataset, col)));
  const filters = [...before.filters];
  for (const c of kept) if (!filters.some((f) => f.dataset === c.dataset && f.sql === c.sql)) filters.push({ dataset: c.dataset, sql: c.sql });
  const removed = [...before.removed];
  const added = [...kept.flatMap((c) => c.columns.map((column) => ({ dataset: c.dataset, column }))), ...removals];
  for (const r of added) if (!removed.some((x) => x.dataset === r.dataset && x.column === r.column)) removed.push(r);
  return { filters, removed };
}

export const CONTEXT_FUNCTIONS: readonly FnDef[] = [
  {
    kind: "expr",
    name: "calculate",
    signature: "calculate(measure, filter, ...)",
    doc: 'The measure with its filters changed. A filter is a condition on the columns of one dataset, which replaces the dashboard\'s filters on those columns, or all_(...), which removes filters. Example: calculate(sum(orders.total), orders.status == "paid")',
    check(call, cx) {
      variadic(call);
      const [measure, ...filters] = call.args;
      if (!measure) fail(call, "calculate() is missing `measure`");
      const t = cx.expr(measure);
      needAggregate("calculate", measure, t);
      if (hasRank(t.sql)) fail(measure, "calculate cannot wrap rank");

      const conditions: Condition[] = [];
      const named: Removal[] = [];
      let everything = false;
      for (const f of filters) {
        if (f.kind !== "call" || f.func !== "all_") {
          conditions.push(condition(f, cx));
          continue;
        }
        const r = removals(f, cx);
        if (r === "everything") everything = true;
        else named.push(...r);
      }

      const sql = mapAtoms(t.sql, (atom) => {
        // a filter travels from the "one" side to the "many" side: it has to be on a dataset the atom reaches
        const reach = reachable(cx.relationships, atom.dataset);
        for (const c of conditions) if (!reach.includes(c.dataset)) fail(c.node, `calculate: ${c.dataset} does not reach ${atom.dataset}`);
        const context = extend(atom.context, conditions, [...named, ...(everything ? reach.map((dataset) => ({ dataset })) : [])]);
        return context.filters.length + context.removed.length > 0 ? { ...atom, context } : atom;
      });
      return { ...t, sql };
    },
  },
  {
    kind: "expr",
    name: "all_",
    signature: "all_(dataset or dataset.column, ...)",
    doc: "Inside calculate: removes the filters (and the chart's grouping) on a dataset, or on one column, from the measure; with no arguments, on everything it reads. Example: calculate(sum(orders.total), all_(customers))",
    check(call) {
      return fail(call, "all_(...) only works as a filter of calculate: calculate(sum(orders.total), all_(customers))");
    },
  },
];
