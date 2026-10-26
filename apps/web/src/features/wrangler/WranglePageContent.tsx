"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";

import { useShell } from "@/features/shell/ShellProvider";

import { WranglerView } from "./WranglerView";

/** A one-line direction, shown only when the wrangler cannot show a table. */
function Direction({ text }: { text: string }) {
  const { t } = useTranslation();
  const { panelOpen, togglePanel } = useShell();
  return (
    <Box sx={{ p: 4, display: "flex", alignItems: "center", gap: 1.5 }}>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {text}
      </Typography>
      {!panelOpen && (
        <Button size="small" onClick={() => togglePanel(true)}>
          {t("Show catalog")}
        </Button>
      )}
    </Box>
  );
}

/** The wrangler page: the table picked in the catalog panel, or what to do to get one. */
export function WranglePageContent({ table, known, hasTables }: { table: string | null; known: boolean; hasTables: boolean }) {
  const { t } = useTranslation();
  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%", bgcolor: "background.default" }}>
      {!hasTables ? (
        <Direction text={t("Add a table to the catalog to wrangle it.")} />
      ) : !table ? (
        <Direction text={t("Pick a table in the catalog to wrangle it.")} />
      ) : !known ? (
        <Direction text={t("There's no table named “{{table}}” in the catalog. Pick one there.", { table })} />
      ) : (
        <WranglerView key={table} kernelKey="workspace" source={{ table }} label={table} height="100%" />
      )}
    </Box>
  );
}
