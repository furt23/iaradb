"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useNotify } from "@/features/shell/notify";
import type { ActionResult } from "@/server/result";

export type SaveStatus = "saved" | "saving" | "error";

const DELAY_MS = 700;

/**
 * Saves a value 700 ms after the last change. Saves run one after another, so
 * an older value never lands after a newer one. `flush` saves what is pending
 * now and resolves when every save so far has finished.
 */
export function useAutosave<T>(save: (value: T) => Promise<ActionResult<unknown>>) {
  const notify = useNotify();
  const [status, setStatus] = useState<SaveStatus>("saved");
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const saveRef = useRef(save);
  saveRef.current = save;

  const flush = useCallback((): Promise<void> => {
    clearTimeout(timer.current);
    const next = pending.current;
    if (!next) return chain.current;
    pending.current = null;
    chain.current = chain.current.then(async () => {
      // a throw must not end the chain: the next save still runs
      const r = await saveRef.current(next.value).catch((e: Error): ActionResult<unknown> => ({ ok: false, error: { type: "error", message: e.message } }));
      if (!r.ok) {
        setStatus("error");
        notify(r.error.message, "error");
      } else if (!pending.current) setStatus("saved");
    });
    return chain.current;
  }, [notify]);

  const schedule = useCallback(
    (value: T) => {
      pending.current = { value };
      setStatus("saving");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), DELAY_MS);
    },
    [flush],
  );

  // leaving the page saves what is pending
  useEffect(() => () => void flush(), [flush]);

  return { status, schedule, flush };
}
