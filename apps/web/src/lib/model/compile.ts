/**
 * Stage 4: a model and a request for measures to one SELECT. Every fact (the
 * rows of a dataset that some aggregations read, in one filter context and
 * along one window) is grouped on its own by the chart's columns, reached
 * through the relationships (facts.ts); this file puts the facts side by side
 * on those columns and renders the measures over their results.
 */

import { quoteIdent } from "@/lib/dashboards/query";

import { guard } from "./calendar";
import { factSql, keyName, planFacts, type Fact, type Ignore } from "./facts";
import { pathToOne } from "./graph";
import { render } from "./parts";
import type { Measure, Model, Param, Template } from "./types";

export type { Ignore } from "./facts";

/** a column a chart groups by: `column` of `dataset`, named `as` in the result */
export interface GroupField {
  dataset: string;
  column: string;
  as: string;
}

export interface ModelQuery {
  /**
   * the rows of a dataset the query reads, narrowed by the dashboard's filters and picks except those in
   * `ignore`: a query text (called once per dataset and ignore set; without `ignore` when there is none)
   */
  source(dataset: string, ignore?: Ignore): string;
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
  /** the params the SQL uses (`:name`), for the caller to bind */
  params: Param[];
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
 * The plain facts that give the result its rows: those that reach more grouping columns than no other
 * plain fact does. A fact that reaches fewer, or reads past the chart's filters, only joins in (its
 * value repeats). Without grouping columns the result is one row, so the first fact will do.
 */
function rowSources(facts: Fact[], keyCount: number): number[] {
  if (keyCount === 0) return [0];
  const reaches = (f: Fact) => f.paths.flatMap((p, i) => (p ? [i] : []));
  const covers = (g: Fact, f: Fact) => reaches(g).length > reaches(f).length && reaches(f).every((i) => g.paths[i]);
  const plain = facts.flatMap((f, i) => (f.plain ? [i] : []));
  return plain.filter((i) => !plain.some((j) => covers(facts[j], facts[i])));
}

/** `:name` in a piece of SQL */
const PARAM = /(?<![:\w]):([A-Za-z_]\w*)/g;

/** a measure's template as SQL: an atom by `atomSql`, a rank as RANK() over the chart's x values, within each series */
function renderTemplate(t: Template, atomSql: (atom: number) => string, series: string | null): string {
  return render(t, atomSql, (inner) => `RANK() OVER (${series ? `PARTITION BY ${series} ` : ""}ORDER BY (${inner}) DESC NULLS LAST)`);
}

/** throws on no measures, an unknown measure, a grouping column that no measure's dataset reaches, or a window that cannot run along x */
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

  const reaching = (m: Measure, k: GroupField) => m.datasets.every((d) => pathToOne(model.relationships, d, k.dataset));
  keys.forEach((k) => {
    if (!chosen.some((m) => m.datasets.some((d) => pathToOne(model.relationships, d, k.dataset)))) {
      throw new Error(`nothing in ${q.measures.join(", ")} reaches ${k.dataset}.${k.column}`);
    }
  });
  const { facts, where } = planFacts(model, chosen, keys, q.x !== null);

  // each dataset's text is asked for once per set of filters it leaves out, and used wherever it is
  const texts = new Map<string, string>();
  const read = new Set<string>();
  const source = (dataset: string, ignore?: Ignore) => {
    const id = ignore ? `${dataset}\0${JSON.stringify(ignore)}` : dataset;
    if (!texts.has(id)) {
      read.add(dataset);
      texts.set(id, guard(ignore ? q.source(dataset, ignore) : q.source(dataset)));
    }
    return texts.get(id)!;
  };
  facts.forEach((f) => source(f.dataset, f.ignore));
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
    // a fact with nothing to read only gives rows
    if ((rows.length === 1 && rows[0] === i) || f.atoms.length === 0) return [];
    const shared = f.paths.flatMap((p, k) => (p ? [k] : []));
    if (shared.length === 0) return [` CROSS JOIN ${from(i)}`];
    return [` LEFT JOIN ${from(i)} ON ${shared.map((k) => sameKey(key(k), `_q${i}.${keyName(k)}`)).join(" AND ")}`];
  });

  // a rank stands within each series
  const series = q.group ? key(keys.length - 1) : null;
  const values = chosen.map((m) =>
    renderTemplate(
      m.expr,
      (a) => {
        const { fact, alias } = where(m.atoms[a]);
        return `_q${fact}.${quoteIdent(alias)}`;
      },
      series,
    ),
  );
  const select = [...keys.map((k, i) => `${key(i)} AS ${quoteIdent(k.as)}`), ...chosen.map((m, i) => `${values[i]} AS ${quoteIdent(m.name)}`)];
  const order = keys.length === 0 ? "" : ` ORDER BY ${q.order === "x" ? keys.map((_, i) => key(i)).join(", ") : `${quoteIdent(chosen[0].name)} DESC NULLS LAST`}`;
  const withs = several ? `WITH ${subqueries.map((s, i) => `_q${i} AS (${s})`).join(", ")} ` : "";

  const notes = chosen.flatMap((m) =>
    keys.flatMap((k) => (reaching(m, k) ? [] : [`\`${m.name}\` does not reach ${k.dataset}.${k.column}: its total repeats`])),
  );

  // the pieces of SQL the model wrote, as they are emitted
  const used = new Set<string>();
  [...facts.flatMap((f) => [...f.atoms.map((a) => a.sql), ...f.filters.map((c) => c.sql)]), ...values].forEach((s) => {
    for (const [, name] of s.matchAll(PARAM)) used.add(name);
  });
  return {
    sql: `${withs}SELECT ${select.join(", ")} FROM ${base}${joined.join("")}${order} LIMIT ${q.limit}`,
    datasets: [...read],
    notes,
    params: model.params.filter((p) => used.has(p.name)),
  };
}
