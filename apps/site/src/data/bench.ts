/**
 * Benchmark results for the site, from benchmarks.json (written by benchmarks/site_data.py).
 * Sums cover every query, so they are only given for engines that ran them all.
 */
import data from './benchmarks.json';

export interface Query {
  label: string;
  ms: Record<string, number | null>;
  notes: Record<string, string>;
}

export interface Suite {
  meta: { date: string; versions: Record<string, string | null>; data: string; runs: number; timeout: number };
  engines: string[];
  queries: Query[];
}

export const names: Record<string, string> = data.names;
export const suites = data.suites as unknown as Record<'tpch_sf10' | 'tpch_sf100' | 'clickbench', Suite>;
export const realistic = (data as { realistic?: RealisticRow[] }).realistic ?? [];

export interface RealisticRow {
  name: string;
  [engine: string]: { s: number; mb: number } | null | string;
}

export const ok = (q: Query, e: string) => q.ms[e] != null && !q.notes[e];

const geomean = (xs: number[]) => Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);

/**
 * Per engine: the sum and geometric mean over all queries (only for engines that ran every query;
 * `wrong` counts results that differ from DuckDB's), and Iara's speed-up over the engine as the
 * geometric mean of per-query ratios on the queries both ran correctly.
 */
export function summary(s: Suite) {
  return {
    of: s.queries.length,
    engines: s.engines.map((e) => {
      const ran = s.queries.filter((q) => q.ms[e] != null);
      const full = ran.length === s.queries.length;
      return {
        key: e,
        name: names[e],
        version: s.meta.versions[e],
        completed: s.queries.filter((q) => ok(q, e)).length,
        ran: ran.length,
        wrong: ran.filter((q) => q.notes[e]).length,
        sumS: full ? ran.reduce((a, q) => a + (q.ms[e] as number), 0) / 1000 : null,
        geomeanMs: full ? geomean(ran.map((q) => q.ms[e] as number)) : null,
        vsIara:
          e === 'iara'
            ? 1
            : geomean(s.queries.filter((q) => ok(q, e) && ok(q, 'iara')).map((q) => (q.ms[e] as number) / (q.ms.iara as number))),
      };
    }),
  };
}

/** Rows for BenchBars: one per query, values in ms, notes for wrong results and failures. */
export const chartRows = (s: Suite) => s.queries.map((q) => ({ label: q.label, values: q.ms, notes: q.notes }));
