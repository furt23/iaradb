"use client";

import Box from "@mui/material/Box";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import type { Cell, Variable } from "@workhouse/protocol";
import { useCallback, useEffect, useState } from "react";

import { OutlinePanel } from "./OutlinePanel";
import { VariablesPanel } from "./VariablesPanel";

export type SideView = "outline" | "variables";

const STORAGE_KEY = "workhouse.notebook.side";

function isView(value: unknown): value is SideView {
  return value === "outline" || value === "variables";
}

/** The view last chosen, remembered by the browser. It is read after mount, so server and client render alike. */
function useSideView(initial: SideView): [SideView, (view: SideView) => void] {
  const [view, setView] = useState<SideView>(initial);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isView(stored)) setView(stored);
    } catch {
      // storage unavailable
    }
  }, []);
  const choose = useCallback((next: SideView) => {
    setView(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage unavailable
    }
  }, []);
  return [view, choose];
}

/** The notebook's right-hand panel: its outline or its variables. */
export function NotebookSidePanel({
  cells,
  variables,
  initial = "outline",
  scrollRoot,
}: {
  cells: Cell[];
  variables: Variable[];
  initial?: SideView;
  /** the notebook's scroll container (the outline scrolls it to a heading) */
  scrollRoot?: HTMLElement | null;
}) {
  const [view, choose] = useSideView(initial);
  return (
    <Box
      component="aside"
      aria-label="notebook side panel"
      sx={{ width: 280, flexShrink: 0, display: "flex", flexDirection: "column", borderLeft: 1, borderColor: "divider", bgcolor: "background.paper", minHeight: 0 }}
    >
      <Box sx={{ display: "flex", alignItems: "center", px: 1.5, height: 48, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          fullWidth
          value={view}
          onChange={(_, next: SideView | null) => next && choose(next)}
          aria-label="side panel view"
        >
          <ToggleButton value="outline">Outline</ToggleButton>
          <ToggleButton value="variables">Variables</ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {view === "outline" ? <OutlinePanel cells={cells} scrollRoot={scrollRoot} /> : <VariablesPanel variables={variables} embedded />}
      </Box>
    </Box>
  );
}
