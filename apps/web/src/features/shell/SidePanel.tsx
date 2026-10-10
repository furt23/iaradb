"use client";

import Box from "@mui/material/Box";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { section, sectionOf, type PanelId } from "./sections";
import { useShell } from "./ShellProvider";

/**
 * The side panel of the current section (files for the workspace, the
 * catalog for data). Panels stay mounted while hidden, so expanded folders
 * and filters survive switching sections.
 */
export function SidePanel({ panels }: { panels: Record<PanelId, ReactNode> }) {
  const { panelOpen } = useShell();
  const current = section(sectionOf(usePathname())).panel;
  return (
    <Box
      component="aside"
      aria-label="side panel"
      sx={{
        width: 260,
        flexShrink: 0,
        display: current && panelOpen ? "flex" : "none",
        flexDirection: "column",
        borderRight: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
        minHeight: 0,
      }}
    >
      {(Object.keys(panels) as PanelId[]).map((id) => (
        <Box key={id} sx={{ display: id === current ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
          {panels[id]}
        </Box>
      ))}
    </Box>
  );
}
