"use client";

import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import { useTranslation } from "react-i18next";

import type { RunStatus, TaskRunStatus } from "@/lib/jobs";

type Color = "default" | "success" | "error" | "warning" | "info";

const COLORS: Record<RunStatus | TaskRunStatus, Color> = {
  pending: "default",
  skipped: "default",
  upstream_failed: "error",
  starting: "info",
  running: "info",
  succeeded: "success",
  failed: "error",
  cancelled: "warning",
};

/** A run's (or a task's) status; a spinner while it goes on. */
export function RunStatusChip({ status, kind = "run" }: { status: RunStatus | TaskRunStatus; kind?: "run" | "task" }) {
  const { t } = useTranslation();
  const live = status === "starting" || status === "running";
  return (
    <Chip
      size="small"
      variant="outlined"
      color={COLORS[status]}
      label={t(status.replaceAll("_", " "))}
      icon={live ? <CircularProgress size={10} color="inherit" sx={{ ml: "6px !important" }} /> : undefined}
      aria-label={`${kind} ${status}`}
    />
  );
}
