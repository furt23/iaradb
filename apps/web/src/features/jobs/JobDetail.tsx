"use client";

import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import StopCircleOutlined from "@mui/icons-material/StopCircleOutlined";
import TuneRounded from "@mui/icons-material/TuneRounded";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useState } from "react";

import { fileHref } from "@/features/workbench/WorkbenchProvider";
import { PageBody, PageHeader } from "@/features/shell/PageHeader";
import { useGuard } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { describeCron } from "@/lib/cron";
import { formatDuration, formatRelative } from "@/lib/format";
import { isFinished, JOB_CLUSTER, type Params } from "@/lib/jobs";
import { cancelJobRun, jobDetail, runJobNow, type JobView } from "@/server/actions/jobs";

import { RunLog } from "./RunLog";
import { RunParamsDialog } from "./RunParamsDialog";
import { RunStatusChip } from "./RunStatusChip";
import { RunTasks } from "./RunTasks";
import { usePolling } from "./usePolling";

/** A job's runs, newest first, and the log of the one picked. */
export function JobDetail({ id }: { id: string }) {
  const { data, error, reload } = usePolling(() => jobDetail(id), (d) => d.runs.some((r) => !isFinished(r.status)));
  const [picked, setPicked] = useState<string | null>(null);
  /** the job whose "run with parameters" dialog is open */
  const [withParams, setWithParams] = useState<JobView | null>(null);
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

  const start = (params?: Params) => act(async () => setPicked(unwrap(await runJobNow(job.id, params)).id));
  const many = job.tasks.length > 1;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHeader
        title={job.name}
        subtitle={
          <>
            {many ? `${job.tasks.length} tasks` : <Link href={fileHref(job.tasks[0].target)}>{job.tasks[0].target}</Link>} · {job.schedule ? describeCron(job.schedule) : "by hand"}
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
            <Stack direction="row" spacing={1}>
              <Button startIcon={<TuneRounded />} onClick={() => setWithParams(job)}>
                Run with parameters…
              </Button>
              <Button variant="contained" color="secondary" startIcon={<PlayArrowRounded />} onClick={() => start()}>
                Run now
              </Button>
            </Stack>
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
        {shown && (shown.tasks?.length ?? 0) > 1 && <RunTasks key={`tasks-${shown.id}`} job={job} run={shown} />}
        {shown && <RunLog key={shown.id} run={shown} />}
      </PageBody>
      <RunParamsDialog
        job={withParams}
        onClose={() => setWithParams(null)}
        onRun={(params) => {
          setWithParams(null);
          start(params);
        }}
      />
    </Box>
  );
}
