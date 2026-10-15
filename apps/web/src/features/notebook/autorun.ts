"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "workhouse.autorun.v1";

/** The notebooks (by path) whose dependent cells run on their own after a cell runs. */
export function parseAutorun(text: string | null): Record<string, true> {
  try {
    const value: unknown = text ? JSON.parse(text) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, on]) => on === true)) as Record<string, true>;
  } catch {
    return {};
  }
}

/**
 * Whether running a cell also runs the cells that read its values (off: they
 * turn stale). A per-notebook choice, remembered by the browser.
 */
export function useAutorun(path: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try {
      setOn(parseAutorun(window.localStorage.getItem(STORAGE_KEY))[path] === true);
    } catch {
      setOn(false); // storage unavailable
    }
  }, [path]);
  const set = useCallback(
    (value: boolean) => {
      setOn(value);
      try {
        const all = parseAutorun(window.localStorage.getItem(STORAGE_KEY));
        if (value) all[path] = true;
        else delete all[path];
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
      } catch {
        // storage unavailable: the choice lasts for this page
      }
    },
    [path],
  );
  return [on, set];
}
