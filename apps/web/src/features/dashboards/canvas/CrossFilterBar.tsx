"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import type { SxProps, Theme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";

import type { CrossPicks, Widget } from "@/lib/dashboards/types";

/**
 * The categories picked in the dashboard's charts, one chip each (the chart's
 * title or x column, then the value) with a ✕ to drop it, and "Clear all".
 * Draws nothing while nothing is picked.
 */
export function CrossFilterBar({
  cross,
  widgets,
  onClear,
  onClearAll,
  sx,
}: {
  cross: CrossPicks;
  widgets: Widget[];
  onClear(widget: string): void;
  onClearAll(): void;
  sx?: SxProps<Theme>;
}) {
  const { t } = useTranslation();
  if (!cross.length) return null;
  const nameOf = (id: string) => {
    const w = widgets.find((x) => x.id === id);
    return w?.kind === "chart" ? w.title || w.spec.x : id;
  };
  return (
    <Box role="group" aria-label={t("Chart filters")} sx={[{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1 }, ...(Array.isArray(sx) ? sx : [sx])]}>
      {cross.map((p) => (
        <Chip key={p.widget} size="small" label={`${nameOf(p.widget)}: ${p.value === null ? t("(empty)") : String(p.value)}`} onDelete={() => onClear(p.widget)} />
      ))}
      <Button size="small" onClick={onClearAll}>
        {t("Clear all")}
      </Button>
    </Box>
  );
}
