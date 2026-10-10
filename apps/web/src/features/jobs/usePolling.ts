"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ActionResult } from "@/server/result";

/**
 * Load `fetch` now and again: every 2 s while `busy(data)` (a run goes on),
 * else every 10 s. Returns the data, the last error and a reload.
 */
export function usePolling<T>(fetch: () => Promise<ActionResult<T>>, busy: (data: T) => boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  const reload = useCallback(async () => {
    const r = await fetchRef.current();
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else setError(r.error.message);
    return r.ok ? r.data : null;
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      const d = await reload();
      if (stopped) return;
      timer = setTimeout(() => void loop(), d && busyRef.current(d) ? 2000 : 10_000);
    };
    void loop();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [reload]);

  return { data, error, reload };
}
