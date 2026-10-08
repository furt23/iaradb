"use client";

import Box from "@mui/material/Box";
import { Fragment, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import type { Arrangement, Pane } from "./workbenchState";

const separatorSx = {
  flexShrink: 0,
  bgcolor: "divider",
  transition: "background-color 120ms",
  "&[data-separator='hover'], &[data-separator='active'], &[data-separator='focus']": { bgcolor: "secondary.main" },
  outline: "none",
} as const;

function Line({ orientation }: { orientation: "horizontal" | "vertical" }) {
  // a horizontal group is split by vertical lines
  return <Box component={Separator} sx={{ ...separatorSx, ...(orientation === "horizontal" ? { width: 4 } : { height: 4 }) }} />;
}

function Strip({ panes, orientation, render }: { panes: Pane[]; orientation: "horizontal" | "vertical"; render(p: Pane): ReactNode }) {
  const size = `${100 / panes.length}`;
  return (
    <Group key={panes.map((p) => p.id).join()} orientation={orientation} style={{ height: "100%", width: "100%" }}>
      {panes.map((p, i) => (
        <Fragment key={p.id}>
          {i > 0 && <Line orientation={orientation} />}
          <Panel id={p.id} defaultSize={size} minSize="12" style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
            {render(p)}
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}

/**
 * Up to four panes, resizable: side by side, stacked, or in a grid (two
 * rows). Pane contents may remount when the arrangement changes; the
 * notebooks they show live in portals and are only re-attached.
 */
export function PaneLayout({ panes, arrangement, render }: { panes: Pane[]; arrangement: Arrangement; render(p: Pane): ReactNode }) {
  if (panes.length === 1) return <>{render(panes[0])}</>;
  if (arrangement === "grid" && panes.length > 2) {
    const top = panes.slice(0, Math.ceil(panes.length / 2));
    const bottom = panes.slice(top.length);
    return (
      <Group key={`grid:${panes.map((p) => p.id).join()}`} orientation="vertical" style={{ height: "100%", width: "100%" }}>
        <Panel id="grid-top" defaultSize="50" minSize="12">
          <Strip panes={top} orientation="horizontal" render={render} />
        </Panel>
        <Line orientation="vertical" />
        <Panel id="grid-bottom" defaultSize="50" minSize="12">
          <Strip panes={bottom} orientation="horizontal" render={render} />
        </Panel>
      </Group>
    );
  }
  return <Strip panes={panes} orientation={arrangement === "rows" ? "vertical" : "horizontal"} render={render} />;
}
