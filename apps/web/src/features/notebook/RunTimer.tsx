"use client";

import TimerOutlined from "@mui/icons-material/TimerOutlined";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";

import { formatDuration } from "@/lib/format";

import type { RunProgress, RunSummary } from "./notebookState";

/** Current time, ticking while `active`. */
function useNow(active: boolean, every = 100): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(t);
  }, [active, every]);
  return now;
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2 }}>
      <span>{label}</span>
      <Box component="span" sx={{ fontFamily: "'JetBrains Mono Variable', monospace" }}>
        {value}
      </Box>
    </Box>
  );
}

export interface RunTimerProps {
  current: RunProgress | null;
  lastRun: RunSummary | null;
  /** sum of every cell's last run time */
  total: number;
  cells: number;
}

/**
 * The notebook's execution time: live while a run goes on (wall clock and
 * cells done), then the total of the cells' times, with the last run's
 * figures on hover.
 */
export function RunTimer({ current, lastRun, total, cells }: RunTimerProps) {
  const now = useNow(current !== null);
  if (!current && !lastRun && total <= 0) return null;
  const done = current ? Object.keys(current.finished).length : 0;
  const label = current ? `${formatDuration(Math.max(0, now - current.startedAt))} · ${done}/${current.queued.length || "…"}` : formatDuration(total);
  const tip = (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 220 }}>
      {current && <Line label="Running for" value={formatDuration(now - current.startedAt)} />}
      {current && <Line label="Cells done" value={`${done} of ${current.queued.length}`} />}
      <Line label="All cells (sum of last runs)" value={formatDuration(total) || "–"} />
      {lastRun && (
        <>
          <Line label="Last run: cells" value={`${lastRun.cells}${lastRun.failed ? ` (${lastRun.failed} failed)` : ""}`} />
          <Line label="Last run: wall time" value={formatDuration(lastRun.finishedAt - lastRun.startedAt)} />
          <Line label="Last run: cell time" value={formatDuration(lastRun.computeMs)} />
        </>
      )}
      <Line label="Cells in notebook" value={String(cells)} />
    </Box>
  );
  return (
    <Tooltip title={tip}>
      <Box
        aria-label="notebook execution time"
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          px: 1,
          py: 0.25,
          borderRadius: 1,
          border: 1,
          borderColor: current ? "ochre.main" : "divider",
          color: current ? "ochre.main" : lastRun?.failed ? "warning.main" : "text.secondary",
          flexShrink: 0,
        }}
      >
        <TimerOutlined sx={{ fontSize: 15 }} />
        <Typography variant="mono" sx={{ fontSize: 12, color: "inherit" }}>
          {label}
        </Typography>
      </Box>
    </Tooltip>
  );
}
