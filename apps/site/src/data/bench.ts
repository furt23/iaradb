/**
 * Benchmark results for the site, from benchmarks.json (written by benchmarks/site_data.py).
 * Summaries only count queries every engine ran with a correct result, so totals compare the same work.
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

/** Queries every engine ran correctly. */
export const common = (s: Suite) => s.queries.filter((q) => s.engines.every((e) => ok(q, e)));

const geomean = (xs: number[]) => Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);

export function summary(s: Suite) {
  const shared = common(s);
  return {
    shared: shared.length,
    of: s.queries.length,
    engines: s.engines.map((e) => ({
      key: e,
      name: names[e],
      version: s.meta.versions[e],
      completed: s.queries.filter((q) => ok(q, e)).length,
      sumS: shared.reduce((a, q) => a + (q.ms[e] as number), 0) / 1000,
      geomeanMs: geomean(shared.map((q) => q.ms[e] as number)),
      // Iara's speed-up over this engine, on the queries both ran correctly
      vsIara:
        e === 'iara'
          ? 1
          : geomean(s.queries.filter((q) => ok(q, e) && ok(q, 'iara')).map((q) => (q.ms[e] as number) / (q.ms.iara as number))),
    })),
  };
}

/** Rows for BenchBars: one per query, values in ms, notes for wrong results and failures. */
export const chartRows = (s: Suite) => s.queries.map((q) => ({ label: q.label, values: q.ms, notes: q.notes }));
