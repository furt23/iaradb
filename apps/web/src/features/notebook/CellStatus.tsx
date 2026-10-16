"use client";

import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { CellStatus } from "@iara/protocol";

import { formatDuration } from "@/lib/format";

const LABELS: Record<CellStatus | "stale", string> = {
  idle: "not run yet",
  queued: "queued",
  running: "running",
  done: "done",
  error: "failed",
  cancelled: "interrupted",
  stale: "edited since the last run",
};

const COLORS: Record<CellStatus | "stale", string> = {
  idle: "transparent",
  queued: "text.disabled",
  running: "ochre.main",
  done: "success.main",
  error: "error.main",
  cancelled: "warning.main",
  stale: "warning.main",
};

export function statusColor(status: CellStatus, stale: boolean): string {
  return COLORS[stale ? "stale" : status];
}

export function CellStatusBadge({ status, stale, elapsed }: { status: CellStatus; stale: boolean; elapsed: number | null }) {
  const key = stale ? "stale" : status;
  return (
    <Tooltip title={LABELS[key]}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
        {status === "running" ? (
          <CircularProgress size={10} thickness={6} />
        ) : (
          <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: COLORS[key], border: status === "idle" ? 1 : 0, borderColor: "text.disabled" }} />
        )}
        {elapsed != null && status !== "running" && status !== "queued" && (
          <Typography variant="mono" sx={{ color: "text.disabled", fontSize: 11, whiteSpace: "nowrap" }}>
            {formatDuration(elapsed)}
          </Typography>
        )}
      </Box>
    </Tooltip>
  );
}
