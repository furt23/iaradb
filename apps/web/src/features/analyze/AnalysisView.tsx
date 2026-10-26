"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";

import { AnalysisHeader } from "./AnalysisHeader";
import { QueryProfile } from "./QueryProfile";
import { QueryBlock } from "./QueryBlock";
import { SummaryCards } from "./SummaryCards";
import type { StoredAnalysis } from "./types";

/** An analysis: its query and totals, then its plan as a graph, its pipelines or its text. */
export function AnalysisView({ analysis }: { analysis: StoredAnalysis }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <AnalysisHeader analysis={analysis} />
      <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0, overflow: "auto" }}>
        <QueryBlock query={analysis.query} />
        <SummaryCards analysis={analysis} />
        <Paper variant="outlined" sx={{ flexShrink: 0, overflow: "hidden", display: "flex", height: "72vh", minHeight: 480 }}>
          <QueryProfile analysis={analysis} />
        </Paper>
      </Box>
    </Box>
  );
}
