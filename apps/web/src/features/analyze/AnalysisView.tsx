"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import type { AnalyzedNode } from "@iara/protocol";
import { useState } from "react";

import { ProfileView } from "@/features/results/ProfileView";

import { AnalysisHeader } from "./AnalysisHeader";
import { NodeDrawer } from "./NodeDrawer";
import { PlanGraph } from "./PlanGraph";
import { QueryBlock } from "./QueryBlock";
import { SummaryCards } from "./SummaryCards";
import type { StoredAnalysis } from "./types";

type View = "graph" | "pipelines" | "text";

/** An analysis: its query and totals, then its plan as a graph, its pipelines or its text. */
export function AnalysisView({ analysis }: { analysis: StoredAnalysis }) {
  const [view, setView] = useState<View>("graph");
  const [picked, setPicked] = useState<AnalyzedNode | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const totalMs = analysis.profile.elapsed_ms;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <AnalysisHeader analysis={analysis} />
      <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0, overflow: "auto" }}>
        <QueryBlock query={analysis.query} />
        <SummaryCards analysis={analysis} />
        <Paper variant="outlined" sx={{ flexShrink: 0, overflow: "hidden" }}>
          <Tabs value={view} onChange={(_, v: View) => setView(v)} sx={{ borderBottom: 1, borderColor: "divider", minHeight: 40 }}>
            <Tab value="graph" label="Graph" sx={{ minHeight: 40 }} />
            <Tab value="pipelines" label="Pipelines" sx={{ minHeight: 40 }} />
            <Tab value="text" label="Plan text" sx={{ minHeight: 40 }} />
          </Tabs>
          {view === "graph" && (
            <PlanGraph
              plan={analysis.plan}
              totalMs={totalMs}
              onOpen={(node) => {
                setPicked(node);
                setDrawerOpen(true);
              }}
            />
          )}
          {view === "pipelines" && (
            <Box sx={{ py: 1 }}>
              <ProfileView profile={analysis.profile} />
            </Box>
          )}
          {view === "text" && (
            <Typography variant="mono" component="pre" sx={{ m: 0, p: 2, whiteSpace: "pre", overflow: "auto", fontSize: 11.5 }}>
              {analysis.text}
            </Typography>
          )}
        </Paper>
      </Box>
      <NodeDrawer node={picked} open={drawerOpen} totalMs={totalMs} onClose={() => setDrawerOpen(false)} />
    </Box>
  );
}
