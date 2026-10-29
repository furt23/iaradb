/**
 * Filter propagation (pure): the query a widget reads is its dataset's rows
 * narrowed by the dashboard's filters and chart picks, and by the same on the
 * datasets it points at through the model's relationships. The filter goes from
 * the "one" side to the "many" side, as in the model's doc: a filter on a fact
 * never narrows its dimensions. A model's calendar is a dataset here: its rows
 * are built from its source datasets' unfiltered rows, and it narrows the facts
 * that point at its dates.
 */

import type { QueryParams } from "@iara/protocol";

import type { ParamRaw } from "@/features/queries/queryParams";
import { calendarSql } from "@/lib/model/calendar";
import type { GroupField, Ignore } from "@/lib/model/compile";
import { outgoing } from "@/lib/model/graph";
import type { Calendar, Relationship } from "@/lib/model/types";

import { datasetQuery, datasetRows, mergeParams, narrows, optionsQuery, rowsQuery, type DatasetQuery, type Semi } from "./query";
import type { Dataset, FilterValues, FilterWidget, PickValue } from "./types";

/** Where a query reads a dataset from: its extract, or its live SQL. */
export type Form = "extract" | "live";

/** A chart's pick on a column of one dataset; `id` is unique in a render and names its parameters. */
export interface PickOn {
  id: number;
  dataset: string;
  column: string;
  value: PickValue;
}

/** A relationship that narrows a dataset: `at` is its place among the dataset's relationships (it names the subquery). */
interface Link {
  rel: Relationship;
  at: number;
  plan: Plan;
}

/** What narrows one dataset in a query: the picks on its own columns, and the datasets that narrow it. */
export interface Plan {
  key: string;
  dataset: string;
  picks: PickOn[];
  /** the dashboard's filters as they apply to this dataset (an ignored column or dataset has none of its fields) */
  filters: FilterWidget[];
  links: Link[];
  /** whether it narrows its rows at all (its own conditions, or a link) */
  narrows: boolean;
}

/**
 * `p.c`, with `p` a dataset of the dashboard (or a calendar of the model), is
 * the column `c` of that dataset; any other text is a column of `dataset`, the
 * widget's own. `as` is the text itself: the name the chart reads the column by.
 */
export function groupField(dataset: string, text: string, names: string[]): GroupField {
  const i = text.indexOf(".");
  const other = i > 0 && names.includes(text.slice(0, i));
  return other ? { dataset: text.slice(0, i), column: text.slice(i + 1), as: text } : { dataset, column: text, as: text };
}

export interface Narrowing {
  rels: Relationship[];
  /** the model's calendars: datasets that exist only here, read through `datasetOf` of their sources */
  calendars: Calendar[];
  filters: FilterWidget[];
  values: FilterValues;
  paramValues: Record<string, ParamRaw>;
  /** the dataset as a query of this form reads it (a live one has its SQL compiled) */
  datasetOf(name: string, form: Form): Dataset;
}

const NONE: Ignore = { datasets: [], columns: [] };

/** The same text for the same ignore, whatever the order of its lists. */
const ignoreKey = (i: Ignore) => JSON.stringify([[...i.datasets].sort(), i.columns.map((c) => JSON.stringify([c.dataset, c.column])).sort()]);

/** The plans and queries of one render, memoised by dataset, the picks that apply and what is ignored. */
export function narrower(n: Narrowing) {
  const plans = new Map<string, Plan>();
  const queries = new Map<string, DatasetQuery>();
  const rows = new Map<string, DatasetQuery>();
  const reach = new Map<string, Set<string>>();
  const calendars = new Map(n.calendars.map((c) => [c.name, c]));

  /**
   * the datasets whose rows can narrow `dataset`: itself, and those it points at, however far, but not through an
   * ignored one (nothing narrows an ignored dataset, so it reaches nothing)
   */
  function reaches(dataset: string, ignore: Ignore): Set<string> {
    const k = JSON.stringify([dataset, [...ignore.datasets].sort()]);
    let seen = reach.get(k);
    if (!seen) {
      const found = new Set<string>();
      const visit = (d: string) => {
        if (found.has(d) || ignore.datasets.includes(d)) return;
        found.add(d);
        for (const r of outgoing(n.rels, d)) visit(r.one.dataset);
      };
      visit(dataset);
      reach.set(k, (seen = found));
    }
    return seen;
  }

  /** the picks that can narrow a dataset: those on it or on a dataset it reaches, and not on an ignored column */
  function relevant<P extends PickOn>(dataset: string, picks: P[], ignore: Ignore = NONE): P[] {
    const set = reaches(dataset, ignore);
    return picks.filter((p) => set.has(p.dataset) && !ignore.columns.some((c) => c.dataset === p.dataset && c.column === p.column));
  }

  /** the dashboard's filters without the fields on an ignored dataset or column of `dataset` (they keep their places: their parameters are named by place) */
  function filtersOf(dataset: string, ignore: Ignore): FilterWidget[] {
    const all = ignore.datasets.includes(dataset);
    const columns = ignore.columns.filter((c) => c.dataset === dataset).map((c) => c.column);
    if (!all && !columns.length) return n.filters;
    const dropped = (f: { dataset: string; column: string }) => f.dataset === dataset && (all || columns.includes(f.column));
    return n.filters.map((f) => (f.fields?.some(dropped) ? { ...f, fields: f.fields.filter((x) => !dropped(x)) } : f));
  }

  /** The plan of `dataset` for the picks given (the ones that cannot reach it are ignored) and the filters and picks `ignore` takes off. */
  function plan(dataset: string, picks: PickOn[], ignore: Ignore = NONE): Plan {
    const mine = relevant(dataset, picks, ignore);
    const key = JSON.stringify([dataset, mine.map((p) => p.id), ignoreKey(ignore)]);
    let p = plans.get(key);
    if (!p) {
      const own = mine.filter((x) => x.dataset === dataset);
      const filters = filtersOf(dataset, ignore);
      // propagation does not pass through an ignored dataset: what it points at does not narrow it
      const links = ignore.datasets.includes(dataset)
        ? []
        : outgoing(n.rels, dataset).flatMap((rel, at) => {
            const child = plan(rel.one.dataset, mine, ignore);
            return child.narrows ? [{ rel, at, plan: child }] : [];
          });
      p = { key, dataset, picks: own, filters, links, narrows: links.length > 0 || narrows(dataset, filters, n.values, own) };
      plans.set(key, p);
    }
    return p;
  }

  /** The datasets whose rows a dataset is made of: a calendar's sources, else itself. */
  function sources(dataset: string): string[] {
    const cal = calendars.get(dataset);
    return cal ? [...new Set(cal.columns.map((c) => c.dataset))] : [dataset];
  }

  /** The datasets a plan's query reads, its own first (a calendar reads its sources). */
  function reads(p: Plan): string[] {
    return [...new Set([...sources(p.dataset), ...p.links.flatMap((l) => reads(l.plan))])];
  }

  /** A calendar's rows: built from the unfiltered rows of its sources, which bring their placeholders along. */
  function calendarRows(cal: Calendar, form: Form): DatasetQuery {
    const missing: string[] = [];
    let params: QueryParams = {};
    const query = calendarSql(cal, (d) => {
      const base = datasetQuery(n.datasetOf(d, form), [], {}, n.paramValues);
      if ("missing" in base) {
        missing.push(...base.missing);
        return "SELECT 1";
      }
      params = mergeParams(params, base.params);
      return base.query;
    });
    return missing.length ? { missing: [...new Set(missing)] } : { query, params };
  }

  /** The rows of a dataset or a calendar, before any narrowing. */
  function rowsOf(dataset: string, form: Form): DatasetQuery {
    const k = `${form}|${dataset}`;
    let r = rows.get(k);
    if (!r) {
      const cal = calendars.get(dataset);
      r = cal ? calendarRows(cal, form) : datasetRows(n.datasetOf(dataset, form), n.paramValues);
      rows.set(k, r);
    }
    return r;
  }

  /** The query of a plan, reading each dataset in `form`: `missing` when a dataset of the query lacks a placeholder's value. */
  function query(p: Plan, form: Form): DatasetQuery {
    const k = `${form}|${p.key}`;
    let q = queries.get(k);
    if (!q) {
      const semis: Semi[] = [];
      const missing: string[] = [];
      for (const l of p.links) {
        const sub = query(l.plan, form);
        if ("missing" in sub) missing.push(...sub.missing);
        else semis.push({ column: l.rel.many.column, key: l.rel.one.column, cast: l.rel.cast, query: sub, alias: `_n${l.at}` });
      }
      const own = rowsOf(p.dataset, form);
      if ("missing" in own) missing.push(...own.missing);
      q = "missing" in own || missing.length ? { missing: [...new Set(missing)] } : rowsQuery(p.dataset, own, p.filters, n.values, p.picks, semis);
      queries.set(k, q);
    }
    return q;
  }

  /** The distinct values of a column of a dataset or a calendar, whole: what a filter offers is not narrowed. */
  function options(dataset: string, column: string, form: Form): DatasetQuery {
    return optionsQuery(rowsOf(dataset, form), column);
  }

  return { plan, relevant, sources, reads, query, options };
}
