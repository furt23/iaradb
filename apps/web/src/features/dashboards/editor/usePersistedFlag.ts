"use client";

import { useCallback, useState } from "react";

/** The flag stored under `key`; `initial` while there is none, on the server and when storage is unavailable. */
function stored(key: string, initial: boolean): boolean {
  try {
    const value = typeof window === "undefined" ? null : window.localStorage.getItem(key);
    return value === "1" ? true : value === "0" ? false : initial;
  } catch {
    return initial;
  }
}

/**
 * A yes/no the browser remembers under `key`. It is read when the component first renders, so use it where the
 * server never renders the component (the dashboard editor draws only once its data has come): a page the
 * server draws would not match.
 */
export function usePersistedFlag(key: string, initial: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => stored(key, initial));
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // storage unavailable
      }
    },
    [key],
  );
  return [value, set];
}
