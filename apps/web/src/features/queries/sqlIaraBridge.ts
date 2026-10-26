"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { IaraAdapter, IaraDecide } from "@/features/iara/types";
import { clipHead, summarizeOutput, waitFor } from "@/features/notebook/iaraBridge";
import type { SqlView, useSqlRunner } from "@/features/sql/useSqlRunner";
import { applyEdits } from "@/lib/iara/edits";
import type { IaraChange, IaraFileContext, IaraOutcome } from "@/lib/iara/protocol";

// the limits of the request's schema (lib/iara/protocol.ts), which rejects a context beyond them
const MAX_QUERY = 20_000;
const MAX_RESULT = 8000;
const MAX_ERROR = 4000;
const RESULT_ROWS = 10;
/** how long a finished run may take to show its result */
const RESULT_MS = 1500;

/** The last result as text: columns and first rows, the plan or the error (undefined: nothing ran yet). */
export function resultSummary(view: SqlView): string | undefined {
  if (!view) return undefined;
  if (view.kind === "error") return clipHead(`Error: ${view.message}`, MAX_RESULT);
  if (view.kind === "explain") return clipHead(`Plan:\n${view.text}`, MAX_RESULT);
  return summarizeOutput(view.output, RESULT_ROWS, MAX_RESULT);
}

/** The SQL editor as Iara sees it: the query and its last result. */
export function sqlContext(path: string, query: string, view: SqlView): IaraFileContext {
  const result = resultSummary(view);
  return { surface: "sql", path: path.slice(0, 1024), query: query.slice(0, MAX_QUERY), ...(result ? { result } : {}) };
}

/** What a query's run came to: `view` is the editor's view after it, `before` the one it had before. */
export function sqlOutcome(view: SqlView, before: SqlView): IaraOutcome {
  const base = { applied: true, ran: true } as const;
  // a run that was stopped leaves the old view in place
  if (!view || view === before) return { ...base, status: "error", error: "The query did not finish." };
  if (view.kind === "error") return { ...base, status: "error", error: clipHead(view.message, MAX_ERROR) };
  if (view.kind === "output" && view.output.type === "error") return { ...base, status: "error", error: clipHead(`${view.output.ename}: ${view.output.evalue}`, MAX_ERROR) };
  return { ...base, status: "ok", output: resultSummary(view) };
}

/** What the SQL tab gives Iara: the file, the query, the runner, and the commands the editor itself uses. */
export interface SqlTab {
  path: string;
  /** the file's text (the query with its header comments) */
  text: string | null;
  body: string;
  runner: ReturnType<typeof useSqlRunner>;
  /** a parameter of the query has no value */
  blocked: boolean;
  /** replaces the query; the file's text after the edit */
  edit(sql: string): string;
  /** the Run button's path; undefined when it did not start (empty query, one already running) */
  run(): Promise<void> | undefined;
}

/** A query edit Iara proposes, shown in the editor until the user keeps or undoes it. */
export interface SqlReview {
  change: Extract<IaraChange, { action: "edit_query" }>;
  /** the query now */
  original: string;
  code: string;
  setCode(code: string): void;
  decide: IaraDecide;
}

/**
 * Iara's door into the SQL editor: the context it reads, the review of the
 * query edit it proposes and the adapter that sets the query and runs it. They
 * read the tab through a ref set after each render, so they see a change once
 * it rendered.
 */
export function useSqlIara(tab: SqlTab) {
  const [review, setReview] = useState<SqlReview | null>(null);
  const live = useRef(tab);
  const shown = useRef(review);
  useEffect(() => {
    live.current = tab;
    shown.current = review;
  });

  const getContext = useCallback(() => sqlContext(live.current.path, live.current.body, live.current.runner.view), []);
  const adapter = useMemo<IaraAdapter>(
    () => ({
      preview(change, decide) {
        if (change.action !== "edit_query") return () => {};
        const original = live.current.body;
        let code: string;
        try {
          code = applyEdits(original, change.edits);
        } catch {
          return () => {};
        }
        setReview({ change, original, code, setCode: (next) => setReview((r) => r && { ...r, code: next }), decide });
        return () => setReview((r) => (r?.change === change ? null : r));
      },
      async apply(change, run) {
        if (change.action !== "edit_query") throw new Error("not possible in the SQL editor");
        if (run && live.current.runner.running) throw new Error("A query is already running");
        const sql = shown.current?.change === change ? shown.current.code : applyEdits(live.current.body, change.edits);
        // the preview goes away in the render that shows the query
        setReview(null);
        const full = live.current.edit(sql);
        if (!(await waitFor(() => live.current.text === full))) throw new Error("The change did not show up in the editor.");
        if (!run) return { applied: true, ran: false };
        if (live.current.blocked) return { applied: true, ran: false, error: "the query needs parameter values first" };
        const before = live.current.runner.view;
        const running = live.current.run();
        if (!running) return { applied: true, ran: false, error: "the query is empty" };
        await running;
        await waitFor(() => !live.current.runner.running && live.current.runner.view !== before, RESULT_MS);
        return sqlOutcome(live.current.runner.view, before);
      },
    }),
    [],
  );
  return { getContext, adapter, review };
}
