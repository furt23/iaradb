"use client";

import { useTheme } from "@mui/material/styles";
import { useEffect, type RefObject } from "react";

import { fileHref } from "@/features/workbench/fileIdRegistry";

const FLASH_MS = 1800;
/** how long to wait for a linked cell that is not rendered yet */
const SEEK_MS = 3000;

/** The cell a URL fragment names (`#cell-<id>`), if any. */
export function cellIdFromHash(hash: string): string | null {
  const m = /^#cell-([A-Za-z0-9_-]{1,32})$/.exec(hash);
  return m ? m[1] : null;
}

/** A link to one cell of a notebook: its URL (by id) plus `#cell-<id>`. */
export function cellLink(path: string, cellId: string, origin: string = window.location.origin): string {
  return `${origin}${fileHref(path)}#cell-${cellId}`;
}

function reveal(root: HTMLElement, id: string, color: string): boolean {
  const cell = root.querySelector<HTMLElement>(`[data-cell-id="${id}"]`);
  if (!cell) return false;
  cell.scrollIntoView({ behavior: "smooth", block: "center" });
  cell.animate([{ boxShadow: `0 0 0 3px ${color}` }, { boxShadow: "0 0 0 3px transparent" }], { duration: FLASH_MS, easing: "ease-out" });
  return true;
}

/**
 * Scroll to the cell the URL names (`#cell-<id>`) and flash it, when the
 * notebook opens and whenever the fragment changes. `rootRef` is the element
 * holding the notebook's cells.
 */
export function useCellAnchor(rootRef: RefObject<HTMLElement | null>): void {
  const color = useTheme().palette.primary.main;
  useEffect(() => {
    let watcher: MutationObserver | null = null;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      watcher?.disconnect();
      watcher = null;
      clearTimeout(giveUp);
    };
    const seek = () => {
      stop();
      const root = rootRef.current;
      const id = cellIdFromHash(window.location.hash);
      if (!root || !id || reveal(root, id, color)) return;
      // the cell is not rendered yet: look again as the notebook fills in
      watcher = new MutationObserver(() => reveal(root, id, color) && stop());
      watcher.observe(root, { childList: true, subtree: true });
      giveUp = setTimeout(stop, SEEK_MS);
    };
    seek();
    window.addEventListener("hashchange", seek);
    return () => {
      window.removeEventListener("hashchange", seek);
      stop();
    };
  }, [rootRef, color]);
}
