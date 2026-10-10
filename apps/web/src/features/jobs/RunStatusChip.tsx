"use client";

import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";

import type { RunStatus } from "@/lib/jobs";

const COLORS: Record<RunStatus, "default" | "success" | "error" | "warning" | "info"> = {
  starting: "info",
  running: "info",
  succeeded: "success",
  failed: "error",
  cancelled: "warning",
};

/** A run's status; a spinner while it goes on. */
export function RunStatusChip({ status }: { status: RunStatus }) {
  const live = status === "starting" || status === "running";
  return (
    <Chip
      size="small"
      variant="outlined"
      color={COLORS[status]}
      label={status}
      icon={live ? <CircularProgress size={10} color="inherit" sx={{ ml: "6px !important" }} /> : undefined}
      aria-label={`run ${status}`}
    />
  );
}
