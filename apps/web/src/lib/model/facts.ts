/**
 * Stage 4a: the facts of a query. A fact is the rows of one dataset that some
 * aggregations read in one filter context and along one window. Each fact is
 * grouped on its own, at the grain of the chart (the columns it groups by,
 * reached through the relationships), and the results are put side by side
 * afterwards (see compile.ts): rows of two facts are never joined one to one,
 * so nothing is counted twice.
 */

import { quoteIdent } from "@/lib/dashboards/query";

import { checkWindow, periodIndex, periodStart, shiftedKey, type Grain } from "./calendar";
import { pathToOne, visited } from "./graph";
import type { Atom, AtomContext, AtomWindow, ColumnRef, Measure, Model, Relationship } from "./types";

/** filters a source must not apply: a whole dataset (and what is reached through it on its "one" side) or one column */
export interface Ignore {
  datasets: string[];
  columns: ColumnRef[];
}

/** a dataset's rows as query text, narrowed by the filters except those in `ignore` */
export type Source = (dataset: string, ignore?: Ignore) => string;

export interface Fact {
  dataset: string;
  /** what it aggregates, each result named `alias` (`__a<n>`) */
  atoms: { sql: string; agg: Atom["agg"]; alias: string }[];
  /** conditions `calculate` adds: boolean SQL over the last dataset of `path` (the fact's own when it is empty) */
  filters: { sql: string; path: Relationship[] }[];
  /** what its sources leave out of the chart's filters */
  ignore?: Ignore;
  window?: AtomWindow;
  /** x's grain, when the window runs along a time column */
  grain: Grain | null;
  /** neither context nor window: it reads the chart's own rows, so it can give the result its rows */
  plain: boolean;
  /** per grouping column: the many→one steps from this dataset to it, null when it does not reach it or its context drops it */
  paths: (Relationship[] | null)[];
}

export interface Plan {
  facts: Fact[];
  /** the fact (index) and the column of the result an atom of the chosen measures is computed in */
  where(atom: Atom): { fact: number; alias: string };
}

/** an atom's context in one order, so that two ways of writing the same one are the same fact */
function normalized(c: AtomContext | undefined): AtomContext {
  const sorted = <T>(items: readonly T[], id: (t: T) => string) =>
    [...new Map(items.map((t) => [id(t), t] as const))].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, t]) => t);
  return {
    filters: sorted(c?.filters ?? [], (f) => `${f.dataset}\0${f.sql}`),
    removed: sorted(c?.removed ?? [], (r) => `${r.dataset}\0${r.column ?? ""}`),
  };
}

const idOf = (a: Atom) => JSON.stringify([a.dataset, a.sql, a.agg, normalized(a.context), a.window ?? null]);
const factOf = (a: Atom) => JSON.stringify([a.dataset, normalized(a.context), a.window ?? null]);

/**
 * Groups the atoms of `measures` by dataset, context and window (one fact each, in order of first use) and finds
 * what each fact reaches. With grouping columns, every dataset also has a plain fact, which may hold no atom: it
 * gives the result its rows as the chart's filters leave them (a shifted or accumulated fact reads past some).
 * `hasX`: the first grouping column is the chart's x axis. Throws when a window cannot run along it.
 */
export function planFacts(model: Pick<Model, "relationships" | "calendars">, measures: readonly Measure[], keys: readonly ColumnRef[], hasX: boolean): Plan {
  const rels = model.relationships;
  const x = hasX ? keys[0] : null;
  const facts: Fact[] = [];
  const index = new Map<string, number>();
  const spots = new Map<string, { fact: number; alias: string }>();

  // a grouping column the context removed (its column, or a dataset on the way, the fact's own included) is left out: its value repeats
  const reach = (dataset: string, removed: AtomContext["removed"]) =>
    keys.map((k) => {
      const path = pathToOne(rels, dataset, k.dataset);
      if (!path) return null;
      const cut = visited(dataset, path).some((d) => removed.some((r) => r.column === undefined && r.dataset === d));
      return cut || removed.some((r) => r.dataset === k.dataset && r.column === k.column) ? null : path;
    });

  for (const m of measures) {
    for (const a of m.atoms) {
      if (spots.has(idOf(a))) continue;
      const grain = a.window ? checkWindow(m.name, a.window, model.calendars, x) : null;
      if (a.window && a.window.kind !== "shift" && a.agg === "count_distinct") throw new Error(`${m.name} cannot add up a distinct count along the x axis`);

      let fact = index.get(factOf(a));
      if (fact === undefined) {
        const ctx = normalized(a.context);
        const paths = reach(a.dataset, ctx.removed);
        if (a.window && !paths[0]) throw new Error(`${m.name} needs the x axis on ${x!.dataset}.${x!.column}, which ${a.dataset} does not reach or a filter in it removes`);
        // time windows read past the calendar's own filters (the others of the chart still narrow the rows)
        const datasets = [...ctx.removed.flatMap((r) => (r.column === undefined ? [r.dataset] : [])), ...(grain && a.window!.kind !== "running" ? [x!.dataset] : [])];
        const columns = ctx.removed.flatMap((r) => (r.column === undefined ? [] : [{ dataset: r.dataset, column: r.column }]));
        fact = facts.push({
          dataset: a.dataset,
          atoms: [],
          // a filter on a dataset this one does not reach narrows nothing
          filters: ctx.filters.flatMap((f) => {
            const path = pathToOne(rels, a.dataset, f.dataset);
            return path ? [{ sql: f.sql, path }] : [];
          }),
          ...(datasets.length + columns.length > 0 && { ignore: { datasets: [...new Set(datasets)].sort(), columns } }),
          ...(a.window && { window: a.window }),
          grain,
          plain: !a.window && ctx.filters.length === 0 && ctx.removed.length === 0,
          paths,
        }) - 1;
        index.set(factOf(a), fact);
      }
      const alias = `__a${spots.size}`;
      facts[fact].atoms.push({ sql: a.sql, agg: a.agg, alias });
      spots.set(idOf(a), { fact, alias });
    }
  }

  if (keys.length > 0) {
    for (const dataset of new Set(facts.map((f) => f.dataset))) {
      if (!facts.some((f) => f.dataset === dataset && f.plain)) facts.push({ dataset, atoms: [], filters: [], grain: null, plain: true, paths: reach(dataset, []) });
    }
  }
  return { facts, where: (a) => spots.get(idOf(a))! };
}

/** `"__k<i>"`: where the i-th grouping column lives in a fact's result */
export const keyName = (i: number) => `"__k${i}"`;

/** the many side of a step, compared as a DATE when the relationship says so */
export const manyOf = (step: Relationship, owner: string) => {
  const column = `${owner}.${quoteIdent(step.many.column)}`;
  return step.cast === "date" ? `CAST(${column} AS DATE)` : column;
};

/**
 * A condition on the dataset at the end of `path`, as a condition on the rows of the first one: semi-joins
 * (`fk IN (SELECT key ...)`) that never duplicate a row, written from the inside out, the last step holding `sql`.
 */
function semiJoin(sql: string, path: readonly Relationship[], source: (dataset: string) => string): string {
  let condition = sql;
  for (let i = path.length - 1; i >= 0; i--) {
    const step = path[i];
    condition = `${manyOf(step, i === 0 ? "_x" : `_s${i}`)} IN (SELECT ${quoteIdent(step.one.column)} FROM (${source(step.one.dataset)}) AS _s${i + 1} WHERE ${condition})`;
  }
  return condition;
}

/** how an atom's value accumulates: sums and counts add up, min and max compare */
function fold(agg: Atom["agg"]): string {
  if (agg === "count_distinct") throw new Error("a distinct count cannot be added up");
  return { sum: "SUM", count: "SUM", min: "MIN", max: "MAX" }[agg];
}

/** a fact's grouped rows with its accumulating window laid over them (`names`: x first, then the other grouping columns) */
function windowed(f: Fact, grouped: string, names: string[]): string {
  const w = f.window!;
  const [x, ...others] = names;
  let partition = others;
  let order = x;
  let frame = "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW";
  if (w.kind === "to_date") partition = [periodStart(x, f.grain!, w.period), ...others];
  if (w.kind === "rolling") {
    if (f.grain) {
      const { index, step } = periodIndex(x, f.grain);
      order = index;
      frame = `RANGE BETWEEN ${(w.n - 1) * step} PRECEDING AND CURRENT ROW`;
    } else {
      frame = `ROWS BETWEEN ${w.n - 1} PRECEDING AND CURRENT ROW`;
    }
  }
  const over = `OVER (${partition.length ? `PARTITION BY ${partition.join(", ")} ` : ""}ORDER BY ${order} ${frame})`;
  const values = f.atoms.map((a) => `${fold(a.agg)}(${quoteIdent(a.alias)}) ${over} AS ${quoteIdent(a.alias)}`);
  return `SELECT ${[...names, ...values].join(", ")} FROM (${grouped}) AS _g`;
}

/**
 * One fact's rows grouped by the columns it reaches: `__k<i>` for each, then its atoms.
 * The dimensions are joined many→one, which never duplicates a fact row; the atoms read
 * the fact's own columns (`_f.*`) as they are written, unqualified.
 */
export function factSql(f: Fact, keys: readonly ColumnRef[], source: Source): string {
  const read = (dataset: string) => source(dataset, f.ignore);
  const joins = new Map<Relationship, string>();
  const on: string[] = [];
  const keyColumns: string[] = [];
  let xKey = "";
  f.paths.forEach((path, i) => {
    if (!path) return;
    let owner = "_f";
    for (const step of path) {
      let alias = joins.get(step);
      if (!alias) {
        alias = `_j${joins.size}`;
        joins.set(step, alias);
        on.push(` LEFT JOIN (${read(step.one.dataset)}) AS ${alias} ON ${manyOf(step, owner)} = ${alias}.${quoteIdent(step.one.column)}`);
      }
      owner = alias;
    }
    const key = `${owner}.${quoteIdent(keys[i].column)}`;
    if (i === 0 && f.window) xKey = key;
    // a shifted fact files each period under the one it is compared to
    keyColumns.push(`${i === 0 && f.window?.kind === "shift" ? shiftedKey(key, f.grain!, f.window.unit) : key} AS ${keyName(i)}`);
  });

  // the conditions narrow the fact's rows before the dimensions join, so that their unqualified columns cannot meet a dimension's
  const conditions = f.filters.map((c) => `(${semiJoin(c.sql, c.path, read)})`);
  const rows = conditions.length ? `(SELECT * FROM (${read(f.dataset)}) AS _x WHERE ${conditions.join(" AND ")})` : `(${read(f.dataset)})`;

  const names = f.paths.flatMap((p, i) => (p ? [keyName(i)] : []));
  // a row with no date is on no period: a window would file it under none, or sort it ahead of the rest
  const dated = f.window ? ` WHERE ${xKey} IS NOT NULL` : "";
  const inner = `SELECT ${["_f.*", ...keyColumns].join(", ")} FROM ${rows} AS _f${on.join("")}${dated}`;
  const select = [...names, ...f.atoms.map((a) => `${a.sql} AS ${quoteIdent(a.alias)}`)].join(", ");
  const grouped = `SELECT ${select} FROM (${inner}) AS _m${names.length ? ` GROUP BY ${names.join(", ")}` : ""}`;
  return f.window && f.window.kind !== "shift" ? windowed(f, grouped, names) : grouped;
}
