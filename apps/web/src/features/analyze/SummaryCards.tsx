"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import type { QueryAnalysis } from "@workhouse/protocol";

import { summaryFacts } from "./summary";

/** The run's totals as cards: time, rows, memory, spill, pipelines and storage requests. */
export function SummaryCards({ analysis }: { analysis: Pick<QueryAnalysis, "rows" | "profile" | "requests"> }) {
  return (
    <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", flexShrink: 0 }}>
      {summaryFacts(analysis).map((f) => (
        <Paper key={f.label} variant="outlined" sx={{ px: 2, py: 1.25, minWidth: 0 }}>
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
            {f.label}
          </Typography>
          <Typography variant="mono" sx={{ fontSize: 15, fontWeight: 700, display: "block", overflowWrap: "anywhere" }}>
            {f.value}
          </Typography>
          {f.hint && (
            <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
              {f.hint}
            </Typography>
          )}
        </Paper>
      ))}
    </Box>
  );
}
