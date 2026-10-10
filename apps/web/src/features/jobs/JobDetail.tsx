"use client";

import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import StopCircleOutlined from "@mui/icons-material/StopCircleOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { fileHref } from "@/features/workbench/WorkbenchProvider";
import { PageBody, PageHeader } from "@/features/shell/PageHeader";
import { useGuard } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { describeCron } from "@/lib/cron";
import { formatDuration, formatRelative } from "@/lib/format";
import { isFinished, JOB_CLUSTER, type JobRun } from "@/lib/jobs";
import { cancelJobRun, jobDetail, runJobNow, runLog } from "@/server/actions/jobs";

import { RunStatusChip } from "./RunStatusChip";
import { usePolling } from "./usePolling";

function RunLog({ run }: { run: JobRun }) {
  const [log, setLog] = useState("");
  const live = !isFinished(run.status);
  const load = useCallback(async () => {
    const r = await runLog(run.job, run.id);
    if (r.ok) setLog(r.data);
  }, [run.job, run.id]);
  // the log grows while the run goes on
  useEffect(() => {
    void load();
    if (!live) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [load, live, run.status]);
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
      <Typography
        variant="mono"
        component="pre"
        aria-label="run log"
        sx={{ m: 0, p: 2, fontSize: 12, whiteSpace: "pre-wrap", maxHeight: 420, overflow: "auto", color: "text.secondary" }}
      >
        {log || "(no output yet)"}
      </Typography>
    </Paper>
  );
}

/** A job's runs, newest first, and the log of the one picked. */
export function JobDetail({ id }: { id: string }) {
  const { data, error, reload } = usePolling(() => jobDetail(id), (d) => d.runs.some((r) => !isFinished(r.status)));
  const [picked, setPicked] = useState<string | null>(null);
  const guard = useGuard();
  if (error && !data) return <Typography sx={{ p: 4, color: "error.main" }}>{error}</Typography>;
  if (!data) return null;
  const { job, runs } = data;
  const shown = runs.find((r) => r.id === picked) ?? runs[0];
  const live = runs.find((r) => !isFinished(r.status));
  const act = (fn: () => Promise<unknown>) =>
    void guard(async () => {
      await fn();
      await reload();
    });

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHeader
        title={job.name}
        subtitle={
          <>
            <Link href={fileHref(job.target)}>{job.target}</Link> · {job.schedule ? describeCron(job.schedule) : "by hand"}
            {job.nextRun && job.enabled ? ` · next ${formatRelative(job.nextRun)}` : ""} ·{" "}
            {job.cluster === JOB_CLUSTER ? `a ${job.instanceType ?? "default"} cluster per run` : `on ${job.cluster}`}
          </>
        }
        actions={
          live ? (
            <Button color="error" startIcon={<StopCircleOutlined />} onClick={() => act(async () => unwrap(await cancelJobRun(live.id)))}>
              Cancel run
            </Button>
          ) : (
            <Button variant="contained" color="secondary" startIcon={<PlayArrowRounded />} onClick={() => act(async () => setPicked(unwrap(await runJobNow(job.id)).id))}>
              Run now
            </Button>
          )
        }
      />
      <PageBody>
        <Button component={Link} href="/jobs" size="small" sx={{ mb: 1 }}>
          ← All jobs
        </Button>
        {!runs.length ? (
          <Typography sx={{ color: "text.secondary" }}>No runs yet.</Typography>
        ) : (
          <Paper variant="outlined">
            <Table size="small" aria-label="runs">
              <TableHead>
                <TableRow>
                  <TableCell>Status</TableCell>
                  <TableCell>Started</TableCell>
                  <TableCell>Took</TableCell>
                  <TableCell>Trigger</TableCell>
                  <TableCell>Cluster</TableCell>
                  <TableCell>Result</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id} hover selected={r.id === shown?.id} onClick={() => setPicked(r.id)} sx={{ cursor: "pointer" }}>
                    <TableCell>
                      <RunStatusChip status={r.status} />
                    </TableCell>
                    <TableCell title={new Date(r.startedAt).toLocaleString()}>{formatRelative(r.startedAt)}</TableCell>
                    <TableCell>{r.endedAt ? formatDuration(r.endedAt - r.startedAt) : "…"}</TableCell>
                    <TableCell>{r.trigger}</TableCell>
                    <TableCell>{r.cluster ?? ""}</TableCell>
                    <TableCell sx={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: r.error ? "error.main" : undefined }}>
                      {r.error ?? r.summary ?? ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        )}
        {shown && <RunLog key={shown.id} run={shown} />}
      </PageBody>
    </Box>
  );
}
