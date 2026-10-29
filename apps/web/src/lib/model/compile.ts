/**
 * Stage 4: a model and a request for measures to one SELECT. Every fact (a
 * dataset the measures aggregate) is grouped on its own by the chart's columns,
 * reached through the relationships (facts.ts); this file puts the facts side
 * by side on those columns and renders the measures over their results.
 */

import { quoteIdent } from "@/lib/dashboards/query";

import { factSql, keyName, planFacts, type Fact } from "./facts";
import { render } from "./parts";
import type { Model } from "./types";

/** a column a chart groups by: `column` of `dataset`, named `as` in the result */
export interface GroupField {
  dataset: string;
  column: string;
  as: string;
}

export interface ModelQuery {
  /** the rows of a dataset the query reads, already narrowed by the filters: a query text (called once per dataset the query reads) */
  source(dataset: string): string;
  x: GroupField | null;
  group: GroupField | null;
  measures: string[];
  /** "x": by x, then group; "value": by the first measure, largest first, empty values last */
  order: "x" | "value";
  limit: number;
}

export interface Compiled {
  sql: string;
  /** the datasets it reads: the measures' datasets and the ones joined to reach a grouping column */
  datasets: string[];
  /** for the author: "`<measure>` does not reach <dataset>.<column>: its total repeats" */
  notes: string[];
}

/**
 * Equality where two empty keys are equal. As a comparison of texts so that the engine hashes it:
 * `IS NOT DISTINCT FROM` (or `a = b OR both are NULL`) makes it compare every pair of rows.
 */
function sameKey(a: string, b: string): string {
  const text = (c: string) => `CASE WHEN ${c} IS NULL THEN 'n' ELSE 'v' || CAST(${c} AS VARCHAR) END`;
  return `${text(a)} = ${text(b)}`;
}

/**
 * The facts that give the result its rows: those that reach more grouping columns than no other
 * fact does. A fact that reaches fewer only joins in (its total repeats on every row).
 * Without grouping columns the result is one row, so the first fact will do.
 */
function rowSources(facts: Fact[], keyCount: number): number[] {
  const reaches = (f: Fact) => f.paths.flatMap((p, i) => (p ? [i] : []));
  const covers = (g: Fact, f: Fact) => reaches(g).length > reaches(f).length && reaches(f).every((i) => g.paths[i]);
  const all = facts.map((_, i) => i);
  return keyCount === 0 ? [0] : all.filter((i) => !facts.some((g) => covers(g, facts[i])));
}

/** throws on no measures, an unknown measure, or a grouping column that no measure's dataset reaches */
export function modelQuery(model: Model, q: ModelQuery): Compiled {
  if (q.measures.length === 0) throw new Error("no measures were asked for");
  if (!Number.isInteger(q.limit) || q.limit < 1) throw new Error("limit must be a positive whole number");
  const chosen = q.measures.map((name) => {
    const m = model.measures.find((x) => x.name === name);
    if (!m) throw new Error(`unknown measure ${name}`);
    return m;
  });
  const keys = [q.x, q.group].filter((k): k is GroupField => k !== null);
  const named = [...keys.map((k) => k.as), ...chosen.map((m) => m.name)];
  const twice = named.find((n, i) => named.indexOf(n) !== i);
  if (twice !== undefined) throw new Error(`the result would have two columns named ${twice}`);

  const { facts, where } = planFacts(model.relationships, chosen, keys);
  keys.forEach((k, i) => {
    if (!facts.some((f) => f.paths[i])) throw new Error(`nothing in ${q.measures.join(", ")} reaches ${k.dataset}.${k.column}`);
  });

  // each dataset's text is asked for once and used wherever the dataset is
  const texts = new Map<string, string>();
  const source = (dataset: string) => {
    if (!texts.has(dataset)) {
      const s = q.source(dataset);
      // a `--` comment at the end of the source would swallow the closing parenthesis
      texts.set(dataset, s.includes("--") ? `\n${s}\n` : s);
    }
    return texts.get(dataset)!;
  };
  facts.forEach((f) => source(f.dataset));
  const subqueries = facts.map((f) => factSql(f, keys, source));

  // one fact is a subquery; several are named, because their keys and their values are both read
  const several = facts.length > 1;
  const from = (i: number) => (several ? `_q${i}` : `(${subqueries[i]}) AS _q${i}`);
  const rows = rowSources(facts, keys.length);
  let key: (i: number) => string;
  let base: string;
  if (rows.length === 1) {
    key = (i) => `_q${rows[0]}.${keyName(i)}`;
    base = from(rows[0]);
  } else {
    // shortcut: when no fact reaches all the columns (each reaches different ones) a source gives the others empty,
    // which a real empty value cannot be told from; upgrade to a cross product of each column's values if charts need it
    const part = (f: number) => `SELECT ${keys.map((_, i) => (facts[f].paths[i] ? keyName(i) : `NULL AS ${keyName(i)}`)).join(", ")} FROM _q${f}`;
    key = (i) => `_k.${keyName(i)}`;
    base = `(${rows.map(part).join(" UNION ")}) AS _k`;
  }
  const joined = facts.flatMap((f, i) => {
    if (rows.length === 1 && rows[0] === i) return [];
    const shared = f.paths.flatMap((p, k) => (p ? [k] : []));
    if (shared.length === 0) return [` CROSS JOIN ${from(i)}`];
    return [` LEFT JOIN ${from(i)} ON ${shared.map((k) => sameKey(key(k), `_q${i}.${keyName(k)}`)).join(" AND ")}`];
  });

  const select = [
    ...keys.map((k, i) => `${key(i)} AS ${quoteIdent(k.as)}`),
    ...chosen.map((m) => {
      const value = render(m.expr, (a) => {
        const { fact, alias } = where(m.atoms[a]);
        return `_q${fact}.${quoteIdent(alias)}`;
      });
      return `${value} AS ${quoteIdent(m.name)}`;
    }),
  ];
  const order = keys.length === 0 ? "" : ` ORDER BY ${q.order === "x" ? keys.map((_, i) => key(i)).join(", ") : `${quoteIdent(chosen[0].name)} DESC NULLS LAST`}`;
  const withs = several ? `WITH ${subqueries.map((s, i) => `_q${i} AS (${s})`).join(", ")} ` : "";

  const notes = chosen.flatMap((m) =>
    keys.flatMap((k, i) =>
      m.datasets.some((d) => !facts.find((f) => f.dataset === d)!.paths[i]) ? [`\`${m.name}\` does not reach ${k.dataset}.${k.column}: its total repeats`] : [],
    ),
  );
  return {
    sql: `${withs}SELECT ${select.join(", ")} FROM ${base}${joined.join("")}${order} LIMIT ${q.limit}`,
    datasets: [...texts.keys()],
    notes,
  };
}
