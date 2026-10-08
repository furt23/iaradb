"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { computeOverview, type ComputeOverview } from "@/server/actions/clusters";

interface ComputeApi {
  overview: ComputeOverview | null;
  error: string | null;
  refresh(): Promise<void>;
}

const ComputeContext = createContext<ComputeApi>({ overview: null, error: null, refresh: async () => {} });

/** One poll of the clusters for the whole app: fast while one starts or stops. */
export function ComputeProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<ComputeOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await computeOverview();
    if (r.ok) {
      setOverview(r.data);
      setError(null);
    } else setError(r.error.message);
  }, []);

  const changing = overview?.clusters.some((c) => c.state === "starting" || c.state === "terminating") ?? false;
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), changing ? 4000 : 20_000);
    return () => clearInterval(timer);
  }, [refresh, changing]);

  const api = useMemo(() => ({ overview, error, refresh }), [overview, error, refresh]);
  return <ComputeContext.Provider value={api}>{children}</ComputeContext.Provider>;
}

export function useCompute(): ComputeApi {
  return useContext(ComputeContext);
}
