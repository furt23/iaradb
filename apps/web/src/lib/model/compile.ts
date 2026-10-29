/**
 * Stage 4: a model and a request for measures to one SELECT. Phase 1 reads one
 * dataset, so the measures run straight over its rows (`_m`), grouped by the
 * columns the widget draws.
 */

import { quoteIdent } from "@/lib/dashboards/query";

import type { Model } from "./types";

export interface MeasureQuery {
  /** the dataset's rows as a SELECT, without a trailing `;` */
  source: string;
  /** the column on the x axis; null: no grouping, one row (counters) */
  x: string | null;
  /** a second grouping column (the series); ignored without `x` */
  group: string | null;
  measures: string[];
  /** "x": by x, then group; "value": by the first measure, largest first, empty values last */
  order: "x" | "value";
  limit: number;
}

/**
 * `SELECT [x,] [group,] <measure sql> AS "<name>", ... FROM (<source>) AS _m
 * [GROUP BY x, group] [ORDER BY ...] LIMIT <limit>`.
 * Throws an Error with no measures, an unknown measure, or measures of different datasets.
 */
export function measureQuery(model: Model, q: MeasureQuery): string {
  if (q.measures.length === 0) throw new Error("no measures were asked for");
  if (!Number.isInteger(q.limit) || q.limit < 1) throw new Error("limit must be a positive whole number");

  const chosen = q.measures.map((name) => {
    const m = model.measures.find((x) => x.name === name);
    if (!m) throw new Error(`unknown measure ${name}`);
    return m;
  });
  const datasets = [...new Set(chosen.map((m) => m.dataset))];
  if (datasets.length > 1) throw new Error(`these measures read different datasets (${datasets.join(", ")}): a query reads one`);

  const groups = q.x === null ? [] : [q.x, ...(q.group === null ? [] : [q.group])].map(quoteIdent);
  const select = [...groups, ...chosen.map((m) => `${m.sql} AS ${quoteIdent(m.name)}`)].join(", ");
  // a `--` comment at the end of the source would swallow the closing parenthesis
  const source = q.source.includes("--") ? `\n${q.source}\n` : q.source;

  let sql = `SELECT ${select} FROM (${source}) AS _m`;
  if (groups.length > 0) {
    sql += ` GROUP BY ${groups.join(", ")}`;
    sql += q.order === "x" ? ` ORDER BY ${groups.join(", ")}` : ` ORDER BY ${quoteIdent(chosen[0].name)} DESC NULLS LAST`;
  }
  return `${sql} LIMIT ${q.limit}`;
}
