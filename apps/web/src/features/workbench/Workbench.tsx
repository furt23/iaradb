"use client";

import Box from "@mui/material/Box";
import { useEffect, useMemo, useState } from "react";

import { catalogSchema } from "@/server/actions/catalog";

import { EmptyPane } from "./EmptyPane";
import { PaneLayout } from "./PaneLayout";
import { StartPane } from "./StartPane";
import { TabHost, TabSlot, useTabElements } from "./TabHost";
import { TabStrip } from "./TabStrip";
import { useWorkbench } from "./WorkbenchProvider";
import { openPaths, type Pane } from "./workbenchState";

const NO_SCHEMA: Record<string, { name: string }[]> = {};

/**
 * Notebooks in tabs and up to four resizable panes. Lives in the root layout:
 * hidden (not unmounted) on other pages, so open notebooks keep their state.
 */
export function Workbench({ name, notebooks }: { name: string; notebooks: string[] }) {
  const { state, visible, act } = useWorkbench();
  const [mounted, setMounted] = useState(false);
  const [schema, setSchema] = useState<Record<string, { name: string }[]> | null>(null);
  const open = openPaths(state);
  const element = useTabElements(open);
  // notebooks on screen (each loads the first time it is shown)
  const shown = useMemo(() => new Set(visible ? state.panes.flatMap((p) => (p.active ? [p.active] : [])) : []), [state.panes, visible]);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (visible && schema === null) void catalogSchema().then((r) => setSchema(r.ok ? r.data : {}));
  }, [visible, schema]);

  if (!mounted) return null;

  const renderPane = (pane: Pane) => {
    // nothing open at all: where to start
    if (state.panes.length === 1 && !pane.tabs.length) return <StartPane name={name} notebooks={notebooks} />;
    const focused = pane.id === state.focused;
    return (
      <Box
        onPointerDownCapture={() => !focused && act({ type: "focus", pane: pane.id })}
        sx={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, height: "100%" }}
      >
        <TabStrip pane={pane} focused={focused} />
        {pane.active ? <TabSlot element={element(pane.active)} /> : <EmptyPane pane={pane} notebooks={notebooks} />}
      </Box>
    );
  };

  return (
    <Box sx={{ display: visible ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0 }}>
      <PaneLayout panes={state.panes} arrangement={state.arrangement} render={renderPane} />
      <TabHost open={open} shown={shown} element={element} schema={schema ?? NO_SCHEMA} />
    </Box>
  );
}
