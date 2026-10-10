"use client";

import type { CellOutput, PlanNode, QueryProfile, RunStreamEvent } from "@workhouse/protocol";
import { useCallback, useState } from "react";

import { useCatalogRefresh } from "@/features/data/useCatalogRefresh";
import { unwrap } from "@/lib/action";
import { streamEvents } from "@/lib/sse";
import { interruptKernel } from "@/server/actions/kernels";
import { explainSql } from "@/server/actions/sql";

export type SqlView = { kind: "output"; output: CellOutput } | { kind: "explain"; plan: PlanNode; text: string } | { kind: "error"; message: string } | null;

/** Runs scratch queries on the workspace kernel, with live progress. */
export function useSqlRunner() {
  const [view, setView] = useState<SqlView>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<QueryProfile[]>([]);
  const refreshCatalog = useCatalogRefresh();

  const run = useCallback(async (query: string) => {
    setRunning(true);
    setProgress([]);
    let catalogChanged = false;
    try {
      await streamEvents("/api/run", { kind: "sql", query }, (e) => {
        const ev = e as RunStreamEvent;
        if (ev.event === "catalog.changed") catalogChanged = true;
        else if (ev.event === "progress") setProgress(ev.data.queries);
        else if (ev.event === "done") setView({ kind: "output", output: ev.data as CellOutput });
        else if (ev.event === "failed") setView({ kind: "error", message: ev.data.message });
      });
    } catch (e) {
      setView({ kind: "error", message: (e as Error).message });
    } finally {
      setRunning(false);
      setProgress([]);
      if (catalogChanged) refreshCatalog();
    }
  }, [refreshCatalog]);

  const explain = useCallback(async (query: string) => {
    try {
      const r = unwrap(await explainSql(query));
      setView({ kind: "explain", plan: r.plan, text: r.text });
    } catch (e) {
      setView({ kind: "error", message: (e as Error).message });
    }
  }, []);

  const interrupt = useCallback(() => interruptKernel("workspace"), []);

  return { view, running, progress, run, explain, interrupt };
}
