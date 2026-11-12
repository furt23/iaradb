/** The rows of a table widget with columns of the datasets it points at: joined many→one, so its rows are neither lost nor repeated. */

import { quoteIdent } from "@/lib/dashboards/query";

import { guard } from "./calendar";
import type { GroupField } from "./compile";
import { manyOf } from "./facts";
import { pathToOne } from "./graph";
import type { Relationship } from "./types";

/** Throws when a column's dataset is not reached from `dataset`. */
export function tableRowsSql(rels: readonly Relationship[], dataset: string, fields: readonly GroupField[], source: (dataset: string) => string): string {
  const joins = new Map<Relationship, string>();
  const on: string[] = [];
  const select = fields.map((f) => {
    const path = pathToOne(rels, dataset, f.dataset);
    if (!path) throw new Error(`${dataset} has no relationship to ${f.dataset}`);
    let owner = "_f";
    for (const step of path) {
      let alias = joins.get(step);
      if (!alias) {
        alias = `_j${joins.size}`;
        joins.set(step, alias);
        on.push(` LEFT JOIN (${guard(source(step.one.dataset))}) AS ${alias} ON ${manyOf(step, owner)} = ${alias}.${quoteIdent(step.one.column)}`);
      }
      owner = alias;
    }
    return `${owner}.${quoteIdent(f.column)} AS ${quoteIdent(f.as)}`;
  });
  return `SELECT ${select.join(", ")} FROM (${guard(source(dataset))}) AS _f${on.join("")}`;
}
