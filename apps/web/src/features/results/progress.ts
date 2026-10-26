import type { QueryProfile } from "@iara/protocol";

/** A pipeline as a line of a query's progress: finished, running, or planned and not started. */
export interface PipelineLine {
  state: "done" | "running" | "pending";
  done: number;
  /** null for a planned pipeline whose size only the run knows */
  total: number | null;
  /** null until it starts */
  ms: number | null;
}

/** A query's pipelines in run order, the planned ones last (pure). */
export function pipelineLines(q: QueryProfile): PipelineLine[] {
  return [
    ...q.pipelines.map((p): PipelineLine => ({
      state: p.finished ? "done" : "running",
      // a pipeline cut short (a LIMIT reached) is complete all the same
      done: p.finished ? p.morsels_total : p.morsels_done,
      total: p.morsels_total,
      ms: p.elapsed_ms,
    })),
    ...(q.pending ?? []).map((p): PipelineLine => ({ state: "pending", done: 0, total: p.morsels, ms: null })),
  ];
}

/**
 * How far a running query is, 0..1: its morsels done over all of them, the
 * planned pipelines' included, so the share does not start over with each
 * pipeline (pure). A planned pipeline of unknown size counts as one morsel.
 */
export function queryProgress(q: QueryProfile): number {
  let done = 0;
  let total = 0;
  for (const p of q.pipelines) {
    // a pipeline cut short (a LIMIT reached) still counts as done
    done += p.finished ? p.morsels_total : p.morsels_done;
    total += p.morsels_total;
  }
  for (const p of q.pending ?? []) total += p.morsels ?? 1;
  return total > 0 ? Math.min(1, done / total) : 0;
}
