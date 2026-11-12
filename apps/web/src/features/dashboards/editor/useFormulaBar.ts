"use client";

import { useMemo, useRef, useState } from "react";

/** What the formula bar is for; `key` is new for each opening, so the bar starts from the measure's text again. */
export type FormulaTarget = { mode: "new"; key: number } | { mode: "edit"; name: string; select: "end" | "name"; key: number };

/** The formula bar's state: closed (no target), writing a new measure, or editing one (with the cursor at its end or its name selected). */
export function useFormulaBar() {
  const [target, setTarget] = useState<FormulaTarget | null>(null);
  const opened = useRef(0);
  return useMemo(
    () => ({
      target,
      openNew: () => setTarget({ mode: "new", key: ++opened.current }),
      openEdit: (name: string, select: "end" | "name" = "end") => setTarget({ mode: "edit", name, select, key: ++opened.current }),
      /** Edits the measure, unless it is the one being edited: what is typed there stays. */
      select: (name: string) => setTarget((t) => (t?.mode === "edit" && t.name === name ? t : { mode: "edit", name, select: "end", key: ++opened.current })),
      close: () => setTarget(null),
    }),
    [target],
  );
}

export type FormulaBarControl = ReturnType<typeof useFormulaBar>;
