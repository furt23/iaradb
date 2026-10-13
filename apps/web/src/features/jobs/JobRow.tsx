"use client";

import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import EditOutlined from "@mui/icons-material/EditOutlined";
import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import StopCircleOutlined from "@mui/icons-material/StopCircleOutlined";
import TuneRounded from "@mui/icons-material/TuneRounded";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Switch from "@mui/material/Switch";
import TableCell from "@mui/material/TableCell";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import Link from "next/link";

import { describeCron } from "@/lib/cron";
import { formatRelative } from "@/lib/format";
import { isFinished, JOB_CLUSTER } from "@/lib/jobs";
import type { JobView } from "@/server/actions/jobs";

import { RunStatusChip } from "./RunStatusChip";

export interface JobActions {
  run(job: JobView): void;
  runWith(job: JobView): void;
  cancel(job: JobView): void;
  edit(job: JobView): void;
  remove(job: JobView): void;
  enable(job: JobView, enabled: boolean): void;
}

/** One job: what it runs, when, where, how its last run went. */
export function JobRow({ job, actions }: { job: JobView; actions: JobActions }) {
  const last = job.lastRun;
  const running = last !== null && !isFinished(last.status);
  return (
    <TableRow hover aria-label={`job ${job.name}`}>
      <TableCell>
        <Typography component={Link} href={`/jobs/${job.id}`} sx={{ fontWeight: 650, color: "text.primary", textDecoration: "none", "&:hover": { color: "secondary.main" } }}>
          {job.name}
        </Typography>
        <Typography variant="mono" component="div" noWrap sx={{ fontSize: 11.5, color: "text.secondary" }}>
          {job.tasks.length > 1 ? `${job.tasks.length} tasks` : job.tasks[0].target}
        </Typography>
      </TableCell>
      <TableCell>
        <Typography variant="body2">{job.schedule ? describeCron(job.schedule) : "by hand"}</Typography>
        {job.nextRun && job.enabled && (
          <Typography variant="body2" sx={{ fontSize: 11.5, color: "text.secondary" }}>
            next {formatRelative(job.nextRun)}
          </Typography>
        )}
      </TableCell>
      <TableCell>
        <Typography variant="body2">{job.cluster === JOB_CLUSTER ? `job cluster · ${job.instanceType ?? "default"}` : job.cluster}</Typography>
      </TableCell>
      <TableCell>
        {last ? (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <RunStatusChip status={last.status} />
            <Typography variant="body2" sx={{ fontSize: 12, color: "text.secondary" }} title={new Date(last.startedAt).toLocaleString()}>
              {formatRelative(last.startedAt)}
            </Typography>
          </Box>
        ) : (
          <Typography variant="body2" sx={{ color: "text.disabled" }}>
            never ran
          </Typography>
        )}
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
        <Tooltip title={job.enabled ? "Scheduled runs on" : "Scheduled runs off"}>
          <Switch size="small" checked={job.enabled} onChange={(e) => actions.enable(job, e.target.checked)} slotProps={{ input: { "aria-label": `${job.name} enabled` } }} />
        </Tooltip>
        {running ? (
          <Tooltip title="Cancel the run">
            <IconButton aria-label={`cancel ${job.name}`} onClick={() => actions.cancel(job)}>
              <StopCircleOutlined fontSize="small" color="error" />
            </IconButton>
          </Tooltip>
        ) : (
          <>
            <Tooltip title="Run with parameters…">
              <IconButton aria-label={`run ${job.name} with parameters`} onClick={() => actions.runWith(job)}>
                <TuneRounded fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Run now">
              <IconButton aria-label={`run ${job.name}`} onClick={() => actions.run(job)}>
                <PlayArrowRounded fontSize="small" color="secondary" />
              </IconButton>
            </Tooltip>
          </>
        )}
        <Tooltip title="Edit">
          <IconButton aria-label={`edit ${job.name}`} onClick={() => actions.edit(job)}>
            <EditOutlined fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Delete">
          <span>
            <IconButton aria-label={`delete ${job.name}`} onClick={() => actions.remove(job)} disabled={running}>
              <DeleteOutline fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </TableCell>
    </TableRow>
  );
}
