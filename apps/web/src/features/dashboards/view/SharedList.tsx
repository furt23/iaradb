"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useTranslation } from "react-i18next";

import { LocalTime } from "@/features/shell/LocalTime";
import type { SharedSummary } from "@/server/actions/view";

/** The dashboards shared with the viewer, each linking to its page (or why they could not be listed). */
export function SharedList({ items, error }: { items: SharedSummary[]; error?: string }) {
  const { t } = useTranslation();
  return (
    <Box sx={{ maxWidth: 880, mx: "auto", p: 3 }}>
      <Typography variant="h2" sx={{ mb: 2 }}>
        {t("Dashboards")}
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {!error && !items.length && <Typography sx={{ color: "text.secondary", py: 6, textAlign: "center" }}>{t("No dashboards have been shared with you yet.")}</Typography>}
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 1.5 }}>
        {items.map((d) => (
          <li key={d.id}>
            <Paper
              variant="outlined"
              component={Link}
              href={`/view/${encodeURIComponent(d.id)}`}
              sx={{ display: "block", px: 2, py: 1.5, color: "text.primary", textDecoration: "none", "&:hover": { borderColor: "text.secondary" } }}
            >
              <Typography variant="h4">{d.title}</Typography>
              {d.description && (
                <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.25 }}>
                  {d.description}
                </Typography>
              )}
              <Typography sx={{ color: "text.disabled", fontSize: 12, mt: 0.75 }}>
                {t("Published")} <LocalTime ms={d.publishedAt} />
              </Typography>
            </Paper>
          </li>
        ))}
      </Box>
    </Box>
  );
}
