"use client";

import { EditorView } from "@codemirror/view";
import type { Cell } from "@iara/protocol";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { findMatches, findRegExp, replaceAll, replaceAt, type FindOptions, type Match } from "./find";

/** Scrolls to the match and, when its cell shows an editor, selects it there. */
function reveal(root: HTMLElement | null, m: Match | undefined) {
  const cell = m && root?.querySelector(`[data-cell-id="${m.cellId}"]`);
  if (!m || !cell) return;
  // centered: the find box floats over the top of the cells
  cell.scrollIntoView({ block: "center" });
  const content = cell.querySelector<HTMLElement>(".cm-content");
  const view = content && EditorView.findFromDOM(content);
  view?.dispatch({ selection: { anchor: m.index, head: m.index + m.length }, effects: EditorView.scrollIntoView(m.index, { y: "center" }) });
}

/** The find bar's state: the search over every cell with code showing, and its replace. */
export function useNotebookFind(cells: Cell[], edit: (id: string, patch: { code: string }) => void, root: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<FindOptions>({ text: "", matchCase: false, regex: false, word: false });
  const [replacement, setReplacement] = useState("");
  const [at, setAt] = useState(0);
  // bumped to reveal the current match again, and to focus the find field
  const [reveals, setReveals] = useState(0);
  const [focuses, setFocuses] = useState(0);
  const regexp = useMemo(() => findRegExp(options), [options]);
  // cells whose code is hidden show no match to go to
  const searched = useMemo(() => cells.filter((c) => c.config.hide_code !== true), [cells]);
  const matches = useMemo(() => (open ? findMatches(searched, regexp) : []), [open, searched, regexp]);
  const current = at < matches.length ? at : 0;
  const latest = useRef({ matches, current });
  latest.current = { matches, current };

  useEffect(() => {
    if (open) reveal(root.current, latest.current.matches[latest.current.current]);
  }, [open, regexp, at, reveals, root]);

  const update = useCallback((next: FindOptions) => {
    setOptions(next);
    setAt(0);
  }, []);
  const show = useCallback(() => {
    setOpen(true);
    setFocuses((n) => n + 1);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const go = useCallback((delta: 1 | -1) => {
    const n = latest.current.matches.length;
    if (!n) return;
    setAt((latest.current.current + delta + n) % n);
    setReveals((r) => r + 1);
  }, []);
  const replaceOne = useCallback(() => {
    const m = latest.current.matches[latest.current.current];
    const cell = m && cells.find((c) => c.id === m.cellId);
    if (!m || !cell) return;
    edit(cell.id, { code: replaceAt(cell.code, m.index, options, replacement) });
    setReveals((r) => r + 1);
  }, [cells, edit, options, replacement]);
  const replaceEverywhere = useCallback(() => {
    for (const [id, code] of replaceAll(searched, options, replacement)) edit(id, { code });
  }, [searched, edit, options, replacement]);

  return {
    open,
    show,
    close,
    focuses,
    options,
    update,
    replacement,
    setReplacement,
    /** what the editors paint: nothing while the bar is closed */
    highlight: open ? regexp : null,
    invalid: !!options.text && !regexp,
    count: matches.length,
    current,
    go,
    replaceOne,
    replaceEverywhere,
  };
}

export type NotebookFind = ReturnType<typeof useNotebookFind>;
