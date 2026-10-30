"use client";

import type { ColumnInfo } from "@iara/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Dataset } from "@/lib/dashboards/types";
import { datasetColumns } from "@/server/actions/dashboards";

/** A dataset's columns, or why they could not be read. */
export type FoundColumns = Record<string, ColumnInfo[] | string>;

const NONE: FoundColumns = {};

/** The columns found for a dataset (none while they are being read or could not be). */
export function columnsIn(found: FoundColumns, name: string): ColumnInfo[] {
  const columns = found[name];
  return Array.isArray(columns) ? columns : [];
}

/**
 * The columns of the dashboard's datasets, read from the kernel when asked for
 * (`load`) and shown until the datasets are read again: the query may have
 * changed in the Data tab.
 */
export function useDatasetColumns(slug: string, datasets: Dataset[]) {
  const [state, setState] = useState<{ datasets: Dataset[]; found: FoundColumns }>({ datasets, found: NONE });
  const found = state.datasets === datasets ? state.found : NONE;

  /** Read the columns again; throws with why they cannot be read (the message is also in `found`). */
  const load = useCallback(
    async (name: string): Promise<ColumnInfo[]> => {
      const r = await datasetColumns(slug, name);
      setState((s) => ({ datasets, found: { ...(s.datasets === datasets ? s.found : NONE), [name]: r.ok ? r.data : r.error.message } }));
      if (!r.ok) throw new Error(r.error.message);
      return r.data;
    },
    [slug, datasets],
  );
  return { found, load };
}

/** Reads the columns of the datasets not read yet, each once (until the datasets change), while `on`. */
export function useReadColumns(datasets: Dataset[], found: FoundColumns, load: (name: string) => Promise<ColumnInfo[]>, on = true) {
  const asked = useRef<{ load: typeof load; names: Set<string> } | null>(null);
  useEffect(() => {
    if (!on) return;
    if (asked.current?.load !== load) asked.current = { load, names: new Set() };
    for (const { name } of datasets) {
      if (found[name] !== undefined || asked.current.names.has(name)) continue;
      asked.current.names.add(name);
      load(name).catch(() => undefined);
    }
  }, [on, datasets, found, load]);
}
