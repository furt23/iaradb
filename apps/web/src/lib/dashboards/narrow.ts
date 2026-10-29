/**
 * Filter propagation (pure): the query a widget reads is its dataset's rows
 * narrowed by the dashboard's filters and chart picks, and by the same on the
 * datasets it points at through the model's relationships. The filter goes from
 * the "one" side to the "many" side, as in the model's doc: a filter on a fact
 * never narrows its dimensions.
 */

import type { ParamRaw } from "@/features/queries/queryParams";
import type { GroupField } from "@/lib/model/compile";
import { outgoing, reachable } from "@/lib/model/graph";
import type { Relationship } from "@/lib/model/types";

import { datasetQuery, narrows, type DatasetQuery, type Semi } from "./query";
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
  links: Link[];
  /** whether it narrows its rows at all (its own conditions, or a link) */
  narrows: boolean;
}

/**
 * `p.c`, with `p` a dataset of the dashboard, is the column `c` of that dataset;
 * any other text is a column of `dataset`, the widget's own. `as` is the text
 * itself: the name the chart reads the column by.
 */
export function groupField(dataset: string, text: string, names: string[]): GroupField {
  const i = text.indexOf(".");
  const other = i > 0 && names.includes(text.slice(0, i));
  return other ? { dataset: text.slice(0, i), column: text.slice(i + 1), as: text } : { dataset, column: text, as: text };
}

export interface Narrowing {
  rels: Relationship[];
  filters: FilterWidget[];
  values: FilterValues;
  paramValues: Record<string, ParamRaw>;
  /** the dataset as a query of this form reads it (a live one has its SQL compiled) */
  datasetOf(name: string, form: Form): Dataset;
}

/** The plans and queries of one render, memoised by dataset and the picks that apply. */
export function narrower(n: Narrowing) {
  const plans = new Map<string, Plan>();
  const queries = new Map<string, DatasetQuery>();
  const reach = new Map<string, Set<string>>();

  /** the datasets whose rows can narrow `dataset`: itself, and those it points at, however far */
  function reaches(dataset: string): Set<string> {
    if (!reach.has(dataset)) reach.set(dataset, new Set([dataset, ...reachable(n.rels, dataset)]));
    return reach.get(dataset)!;
  }

  /** the picks that can narrow a dataset: those on it or on a dataset it reaches */
  function relevant<P extends PickOn>(dataset: string, picks: P[]): P[] {
    const set = reaches(dataset);
    return picks.filter((p) => set.has(p.dataset));
  }

  /** The plan of `dataset` for the picks given (the ones that cannot reach it are ignored). */
  function plan(dataset: string, picks: PickOn[]): Plan {
    const mine = relevant(dataset, picks);
    const key = JSON.stringify([dataset, mine.map((p) => p.id)]);
    let p = plans.get(key);
    if (!p) {
      const own = mine.filter((x) => x.dataset === dataset);
      const links = outgoing(n.rels, dataset).flatMap((rel, at) => {
        const child = plan(rel.one.dataset, mine);
        return child.narrows ? [{ rel, at, plan: child }] : [];
      });
      p = { key, dataset, picks: own, links, narrows: links.length > 0 || narrows(dataset, n.filters, n.values, own) };
      plans.set(key, p);
    }
    return p;
  }

  /** The datasets a plan's query reads, its own first. */
  function reads(p: Plan): string[] {
    return [...new Set([p.dataset, ...p.links.flatMap((l) => reads(l.plan))])];
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
        else semis.push({ column: l.rel.many.column, key: l.rel.one.column, query: sub, alias: `_n${l.at}` });
      }
      const own = datasetQuery(n.datasetOf(p.dataset, form), n.filters, n.values, n.paramValues, p.picks, semis);
      if ("missing" in own) missing.push(...own.missing);
      q = missing.length ? { missing: [...new Set(missing)] } : own;
      queries.set(k, q);
    }
    return q;
  }

  return { plan, relevant, reads, query };
}
