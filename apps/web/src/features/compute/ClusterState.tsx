"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";

import type { ClusterState, ClusterView } from "@/server/compute/types";

const COLORS: Record<ClusterState, string> = {
  running: "success.main",
  starting: "warning.main",
  terminating: "warning.main",
  terminated: "text.disabled",
  error: "error.main",
};

const LABELS: Record<ClusterState, string> = {
  running: "Running",
  starting: "Starting",
  terminating: "Terminating",
  terminated: "Terminated",
  error: "Error",
};

export function stateLabel(c: Pick<ClusterView, "state" | "phase">): string {
  return c.phase && (c.state === "starting" || c.state === "terminating") ? `${LABELS[c.state]}: ${c.phase}` : LABELS[c.state];
}

export function StateDot({ state }: { state: ClusterState }) {
  const pulsing = state === "starting" || state === "terminating";
  return (
    <Box
      aria-label={`cluster ${state}`}
      sx={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        flexShrink: 0,
        bgcolor: COLORS[state],
        ...(pulsing && { animation: "wh-pulse 1.2s ease-in-out infinite", "@keyframes wh-pulse": { "50%": { opacity: 0.35 } } }),
      }}
    />
  );
}

export function StateChip({ cluster }: { cluster: ClusterView }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      icon={<Box sx={{ display: "flex", pl: 0.75 }}><StateDot state={cluster.state} /></Box>}
      label={stateLabel(cluster)}
      title={cluster.error}
      sx={{ maxWidth: 320 }}
    />
  );
}

/** "2 vCPU · 8 GiB · ≈$0.10/h" */
export function machineSummary(c: ClusterView): string {
  if (c.kind === "local") return "this machine";
  const t = c.instanceType;
  return t ? `${t.name} · ${t.vcpus} vCPU · ${t.memoryGib} GiB · ≈$${t.usdPerHour.toFixed(2)}/h` : "unknown machine";
}
