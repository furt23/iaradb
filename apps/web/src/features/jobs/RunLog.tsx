"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, useState } from "react";

import { isFinished, type JobRun } from "@/lib/jobs";
import { runLog } from "@/server/actions/jobs";
import type { ActionResult } from "@/server/result";

import { RunStatusChip } from "./RunStatusChip";

/** A log that grows while `live`: loaded now and every 2 s (and again when `rev` changes: a run that ended). */
export function LogText({ load, live, label, rev }: { load(): Promise<ActionResult<string>>; live: boolean; label: string; rev: string }) {
  const [log, setLog] = useState("");
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let stopped = false;
    const run = async () => {
      const r = await loadRef.current();
      if (r.ok && !stopped) setLog(r.data);
    };
    void run();
    if (!live) return;
    const timer = setInterval(() => void run(), 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [rev, live]);
  return (
    <Typography variant="mono" component="pre" aria-label={label} sx={{ m: 0, p: 2, fontSize: 12, whiteSpace: "pre-wrap", maxHeight: 420, overflow: "auto", color: "text.secondary" }}>
      {log || "(no output yet)"}
    </Typography>
  );
}

/** The job-level log of a run. */
export function RunLog({ run }: { run: JobRun }) {
  const live = !isFinished(run.status);
  return (
    <Paper variant="outlined" sx={{ mt: 2 }}>
      <Box sx={{ px: 2, py: 1, borderBottom: 1, borderColor: "divider", display: "flex", gap: 1, alignItems: "center" }}>
        <Typography sx={{ fontWeight: 650, fontSize: 13 }}>Run {run.id}</Typography>
        <RunStatusChip status={run.status} />
        {run.error && (
          <Typography noWrap sx={{ fontSize: 12.5, color: "error.main" }} title={run.error}>
            {run.error}
          </Typography>
        )}
      </Box>
      <LogText load={() => runLog(run.job, run.id)} live={live} label="run log" rev={`${run.job}/${run.id}/${run.status}`} />
    </Paper>
  );
}
