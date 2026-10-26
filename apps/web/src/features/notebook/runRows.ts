import type { Cell, CellState, CellStatus, QueryProfile } from "@iara/protocol";

import { queryProgress } from "@/features/results/progress";

/** A cell of a run, as the run panel lists it. */
export interface RunRow {
  id: string;
  /** its place among the notebook's cells, from 1 */
  number: number;
  /** its first line of code, cut short */
  preview: string;
  status: CellStatus;
  elapsed: number | null;
  /** while it runs a query: how far the query is (0..1) and the pipeline it is on */
  query?: { share: number; pipeline: number; pipelines: number };
}

const PREVIEW = 48;

function preview(code: string): string {
  const line = code.split("\n").find((l) => l.trim()) ?? "";
  const t = line.trim();
  return t.length > PREVIEW ? `${t.slice(0, PREVIEW - 1)}…` : t;
}

/** Where a running query is: its share done and the pipeline it is on, of how many. */
function where(q: QueryProfile): RunRow["query"] {
  const unfinished = q.pipelines.findIndex((p) => !p.finished);
  const pipeline = unfinished >= 0 ? unfinished + 1 : q.pipelines.length;
  return { share: queryProgress(q), pipeline, pipelines: q.pipelines.length + (q.pending?.length ?? 0) };
}

/**
 * The cells a run queued, in its order (pure): each with its number in the
 * notebook, its state and, while it runs a query, where that query is. Cells
 * no longer in the notebook are left out.
 */
export function runRows(queued: string[], cells: Cell[], states: Record<string, CellState>, progress: Record<string, QueryProfile[]>): RunRow[] {
  const at = new Map(cells.map((c, i) => [c.id, i]));
  return queued.flatMap((id): RunRow[] => {
    const i = at.get(id);
    if (i === undefined) return [];
    const s = states[id];
    const status = s?.status ?? "queued";
    const running = progress[id]?.at(-1);
    return [
      {
        id,
        number: i + 1,
        preview: preview(cells[i].code),
        status,
        elapsed: s?.elapsed_ms ?? null,
        query: status === "running" && running && running.pipelines.length > 0 ? where(running) : undefined,
      },
    ];
  });
}
