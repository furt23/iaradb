"use client";

import { useEffect, useMemo, useRef } from "react";

export interface DebouncedSave<T> {
  /** save `value` under `key` once `ms` pass without another call for that key */
  schedule(key: string, value: T): void;
  /** drop what is waiting for `key` (its target is gone) */
  cancel(key: string): void;
  /** save everything that is waiting now */
  flush(): Promise<void>;
}

/**
 * Saves per key, a while after the last change to it: typing or dragging
 * sends one request. What is still waiting is saved when the component goes away.
 */
export function useDebouncedSave<T>(save: (key: string, value: T) => Promise<void>, ms: number): DebouncedSave<T> {
  const latest = useRef(save);
  latest.current = save;
  const api = useMemo(() => {
    const waiting = new Map<string, { value: T; timer: ReturnType<typeof setTimeout> }>();
    const cancel = (key: string) => {
      clearTimeout(waiting.get(key)?.timer);
      waiting.delete(key);
    };
    const run = (key: string) => {
      const entry = waiting.get(key);
      if (!entry) return Promise.resolve();
      cancel(key);
      return latest.current(key, entry.value);
    };
    return {
      schedule(key: string, value: T) {
        cancel(key);
        waiting.set(key, { value, timer: setTimeout(() => void run(key), ms) });
      },
      cancel,
      flush: async () => void (await Promise.all([...waiting.keys()].map(run))),
    };
  }, [ms]);
  useEffect(() => () => void api.flush(), [api]);
  return api;
}
