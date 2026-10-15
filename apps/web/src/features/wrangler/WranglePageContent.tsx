"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";

import { useShell } from "@/features/shell/ShellProvider";

import { WranglerView } from "./WranglerView";

/** A one-line direction, shown only when the wrangler cannot show a table. */
function Direction({ text }: { text: string }) {
  const { panelOpen, togglePanel } = useShell();
  return (
    <Box sx={{ p: 4, display: "flex", alignItems: "center", gap: 1.5 }}>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {text}
      </Typography>
      {!panelOpen && (
        <Button size="small" onClick={() => togglePanel(true)}>
          Show catalog
        </Button>
      )}
    </Box>
  );
}

/** The wrangler page: the table picked in the catalog panel, or what to do to get one. */
export function WranglePageContent({ table, known, hasTables }: { table: string | null; known: boolean; hasTables: boolean }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%", bgcolor: "background.default" }}>
      {!hasTables ? (
        <Direction text="Add a table to the catalog to wrangle it." />
      ) : !table ? (
        <Direction text="Pick a table in the catalog to wrangle it." />
      ) : !known ? (
        <Direction text={`There's no table named “${table}” in the catalog. Pick one there.`} />
      ) : (
        <WranglerView key={table} kernelKey="workspace" source={{ table }} label={table} height="100%" />
      )}
    </Box>
  );
}
