"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MAX_PICKS } from "@/lib/dashboards/query";
import type { CrossPicks, FilterValue, FilterValues, PickValue, RenderResult } from "@/lib/dashboards/types";
import type { ActionResult } from "@/server/result";

const FILTER_DELAY_MS = 300;

/**
 * A dashboard's data: `load` runs on mount, when a filter value changes (after
 * a short pause, so typing sends one request), when a chart pick changes (at
 * once: a click is one change), when `reloadKey` changes and on `refresh()`.
 * The last result stays while the next loads, and an answer that a newer
 * request has overtaken is dropped. `pickable`: the charts that can be picked
 * from; the pick of any other widget (removed, or no longer such a chart) is dropped.
 */
export function useDashboardData(
  load: (values: FilterValues, cross: CrossPicks) => Promise<ActionResult<RenderResult>>,
  reloadKey?: unknown,
  pickable?: ReadonlySet<string>,
): {
  result: RenderResult | null;
  loading: boolean;
  error: string | null;
  values: FilterValues;
  setValue(id: string, value: FilterValue | undefined): void;
  cross: CrossPicks;
  /** picks the category `value` of a chart (undefined: clears the chart's pick) */
  setPick(widget: string, value: PickValue | undefined): void;
  clearPicks(): void;
  refresh(): void;
} {
  const [values, setValues] = useState<FilterValues>({});
  const [picks, setPicks] = useState<CrossPicks>([]);
  const [result, setResult] = useState<RenderResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const latestLoad = useRef(load);
  const loadedValues = useRef(values);
  useEffect(() => {
    latestLoad.current = load;
  });

  // the picks that count now; the state is cleaned just after, so the one render in between asks the server for no pick of a widget that is gone
  const cross = useMemo(() => {
    const live = pickable ? picks.filter((p) => pickable.has(p.widget)) : picks;
    return live.length === picks.length ? picks : live;
  }, [picks, pickable]);
  useEffect(() => {
    if (pickable) setPicks((prev) => (prev.every((p) => pickable.has(p.widget)) ? prev : prev.filter((p) => pickable.has(p.widget))));
  }, [pickable]);

  useEffect(() => {
    // only a new filter value waits; the first load, a pick, a reload and a refresh go at once
    const delay = loadedValues.current === values ? 0 : FILTER_DELAY_MS;
    loadedValues.current = values;
    let current = true;
    setLoading(true);
    const timer = setTimeout(() => {
      latestLoad.current(values, cross).then(
        (r) => {
          if (!current) return;
          setLoading(false);
          if (r.ok) {
            setResult(r.data);
            setError(null);
          } else setError(r.error.message);
        },
        (e: unknown) => {
          if (!current) return;
          setLoading(false);
          setError(e instanceof Error ? e.message : String(e));
        },
      );
    }, delay);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [values, cross, reloadKey, refreshes]);

  const setValue = useCallback((id: string, value: FilterValue | undefined) => {
    setValues((prev) => {
      if (value === undefined && !(id in prev)) return prev;
      const next = { ...prev };
      if (value === undefined) delete next[id];
      else next[id] = value;
      return next;
    });
  }, []);
  const setPick = useCallback((widget: string, value: PickValue | undefined) => {
    setPicks((prev) => {
      const at = prev.findIndex((p) => p.widget === widget);
      if (value === undefined) return at < 0 ? prev : prev.filter((_, i) => i !== at);
      const pick = { widget, value };
      // a re-pick keeps its place among the chips
      if (at >= 0) return prev.map((p, i) => (i === at ? pick : p));
      return prev.length >= MAX_PICKS ? prev : [...prev, pick];
    });
  }, []);
  const clearPicks = useCallback(() => setPicks((prev) => (prev.length ? [] : prev)), []);
  const refresh = useCallback(() => setRefreshes((n) => n + 1), []);

  return { result, loading, error, values, setValue, cross, setPick, clearPicks, refresh };
}
