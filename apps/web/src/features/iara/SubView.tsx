"use client";

import ArrowBack from "@mui/icons-material/ArrowBack";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

import { useTranslation } from "@/i18n";

/** A page of the panel that is not the conversation (history, memories): a title with a back button over a scrolling body. */
export function SubView({ title, onBack, children }: { title: string; onBack(): void; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, px: 1, py: 0.5, flexShrink: 0 }}>
        <IconButton size="small" aria-label={t("Back")} onClick={onBack}>
          <ArrowBack fontSize="small" />
        </IconButton>
        <Typography sx={{ fontWeight: 650, fontSize: 14 }}>{title}</Typography>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 1.5, pb: 1.5 }}>{children}</Box>
    </Box>
  );
}
