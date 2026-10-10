"use client";

import Box from "@mui/material/Box";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { SqlFileTab } from "@/features/queries/SqlFileTab";

import { NotebookTab } from "./NotebookTab";

/**
 * One DOM node per open notebook. Each notebook renders into its node once
 * (a portal); panes attach the node of the tab they show. Switching tabs,
 * moving a tab to another pane or rearranging panes moves DOM nodes, never
 * React state: editors, outputs and running streams survive.
 */
export function useTabElements(open: string[]) {
  const elements = useRef(new Map<string, HTMLDivElement>());
  const get = useCallback((path: string) => {
    let el = elements.current.get(path);
    if (!el) {
      el = document.createElement("div");
      el.style.cssText = "flex:1;min-height:0;min-width:0;display:flex;flex-direction:column";
      elements.current.set(path, el);
    }
    return el;
  }, []);
  const key = open.join("\n");
  useEffect(() => {
    const keep = new Set(key.split("\n"));
    for (const path of [...elements.current.keys()]) if (!keep.has(path)) elements.current.delete(path);
  }, [key]);
  return get;
}

export function TabHost({ open, shown, element, schema }: { open: string[]; shown: Set<string>; element(path: string): HTMLDivElement; schema: Record<string, { name: string }[]> }) {
  return (
    <>
      {open.map((path) => {
        const Tab = path.toLowerCase().endsWith(".sql") ? SqlFileTab : NotebookTab;
        return createPortal(<Tab path={path} shown={shown.has(path)} schema={schema} />, element(path), path);
      })}
    </>
  );
}

/** Where a pane shows its active notebook. */
export function TabSlot({ element }: { element: HTMLDivElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.appendChild(element);
    return () => {
      if (element.parentNode === host) host.removeChild(element);
    };
  }, [element]);
  return <Box ref={ref} sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }} />;
}
