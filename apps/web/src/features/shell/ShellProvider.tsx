"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { RAIL_KEY, railExpandedFrom, railStoredValue } from "./railPrefs";

const STORAGE_KEY = "workhouse.sidePanel.v1";

export interface ShellApi {
  /** the side panel is shown (it can be hidden for more room) */
  panelOpen: boolean;
  togglePanel(open?: boolean): void;
  /** the navigation rail shows the section names (narrow windows show icons anyway) */
  railExpanded: boolean;
  toggleRail(): void;
  /** the quick open dialog (Ctrl/Cmd+K or Ctrl/Cmd+P) */
  quickOpen: boolean;
  setQuickOpen(open: boolean): void;
}

const ShellContext = createContext<ShellApi | null>(null);

/** Cmd on Apple keyboards (where Ctrl+B moves the cursor), Ctrl elsewhere. */
export function isModKey(e: KeyboardEvent): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * Layout state of the shell, remembered by the browser. Ctrl/Cmd+B shows or
 * hides the side panel; Ctrl/Cmd+K (or P) opens anything by name.
 */
export function ShellProvider({ children }: { children: ReactNode }) {
  const [panelOpen, setPanelOpen] = useState(true);
  const [railExpanded, setRailExpanded] = useState(true);
  const [quickOpen, setQuickOpen] = useState(false);

  // read after the first render, so the server and the first client render agree
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "closed") setPanelOpen(false);
      setRailExpanded(railExpandedFrom(window.localStorage.getItem(RAIL_KEY)));
    } catch {
      // storage unavailable
    }
  }, []);

  const toggleRail = useCallback(() => {
    setRailExpanded((was) => {
      const next = !was;
      try {
        window.localStorage.setItem(RAIL_KEY, railStoredValue(next));
      } catch {
        // storage unavailable
      }
      return next;
    });
  }, []);

  const togglePanel = useCallback((open?: boolean) => {
    setPanelOpen((was) => {
      const next = open ?? !was;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "open" : "closed");
      } catch {
        // storage unavailable
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModKey(e) || e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "b") {
        e.preventDefault();
        togglePanel();
      } else if (key === "k" || key === "p") {
        e.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePanel]);

  const api = useMemo(
    () => ({ panelOpen, togglePanel, railExpanded, toggleRail, quickOpen, setQuickOpen }),
    [panelOpen, togglePanel, railExpanded, toggleRail, quickOpen],
  );
  return <ShellContext.Provider value={api}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellApi {
  const api = useContext(ShellContext);
  if (!api) throw new Error("useShell outside ShellProvider");
  return api;
}
