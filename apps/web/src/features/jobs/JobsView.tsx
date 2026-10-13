"use client";

import Add from "@mui/icons-material/Add";
import EventRepeatOutlined from "@mui/icons-material/EventRepeatOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { PageBody, PageHeader } from "@/features/shell/PageHeader";
import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { isFinished, type JobSpec, type Params } from "@/lib/jobs";
import { cancelJobRun, jobsOverview, removeJob, runJobNow, setJobEnabled, type JobView } from "@/server/actions/jobs";

import { JobDialog } from "./JobDialog";
import { JobRow, type JobActions } from "./JobRow";
import { RunParamsDialog } from "./RunParamsDialog";
import { usePolling } from "./usePolling";

/** Jobs: notebooks and queries that run by hand or on a schedule. */
export function JobsView({ targets, newTarget }: { targets: string[]; newTarget: string | null }) {
  const { data, error, reload } = usePolling(jobsOverview, (d) => d.jobs.some((j) => j.lastRun && !isFinished(j.lastRun.status)));
  const [editing, setEditing] = useState<{ job: JobSpec | null; target?: string } | null>(null);
  const [removing, setRemoving] = useState<JobView | null>(null);
  const [runningWith, setRunningWith] = useState<JobView | null>(null);
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();

  // "Schedule as a job" from a file's menu lands here with the file
  useEffect(() => {
    if (newTarget) setEditing({ job: null, target: newTarget });
  }, [newTarget]);

  /** Do something, then show the jobs as they are now. */
  const act = (fn: () => Promise<unknown>) =>
    void guard(async () => {
      await fn();
      await reload();
    });
  const start = (j: JobView, params?: Params) =>
    act(async () => {
      unwrap(await runJobNow(j.id, params));
      notify(`${j.name} started`, "success");
    });
  const actions: JobActions = {
    run: (j) => start(j),
    runWith: (j) => setRunningWith(j),
    cancel: (j) => act(async () => j.lastRun && unwrap(await cancelJobRun(j.lastRun.id))),
    edit: (j) => setEditing({ job: j }),
    remove: (j) => setRemoving(j),
    enable: (j, enabled) => act(async () => unwrap(await setJobEnabled(j.id, enabled))),
  };
  const jobs = data?.jobs ?? [];

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHeader
        title="Jobs"
        subtitle="Notebooks and queries that run on a schedule (UTC) or by hand, on a cluster of their own"
        actions={
          <Button variant="contained" color="secondary" startIcon={<Add />} onClick={() => setEditing({ job: null })}>
            New job
          </Button>
        }
      />
      <PageBody>
        {error && <Typography sx={{ color: "error.main", mb: 2 }}>{error}</Typography>}
        {data?.problems.map((p) => (
          <Typography key={p.id} sx={{ color: "warning.main", mb: 1, fontSize: 13 }}>
            jobs/{p.id}.toml: {p.error}
          </Typography>
        ))}
        {data && !jobs.length && (
          <Box sx={{ textAlign: "center", py: 8, color: "text.secondary" }}>
            <EventRepeatOutlined sx={{ fontSize: 40, color: "text.disabled" }} />
            <Typography variant="h4" sx={{ color: "text.primary", mt: 1 }}>
              No jobs yet
            </Typography>
            <Typography variant="body2" sx={{ maxWidth: 440, mx: "auto", mt: 0.5 }}>
              A job runs a notebook or a query file without anyone watching: every morning, every hour, or when you start it. Jobs are files in jobs/, versioned with the workspace.
            </Typography>
          </Box>
        )}
        {jobs.length > 0 && (
          <Paper variant="outlined">
            <Table size="small" aria-label="jobs">
              <TableHead>
                <TableRow>
                  <TableCell>Job</TableCell>
                  <TableCell>Schedule</TableCell>
                  <TableCell>Cluster</TableCell>
                  <TableCell>Last run</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {jobs.map((j) => (
                  <JobRow key={j.id} job={j} actions={actions} />
                ))}
              </TableBody>
            </Table>
          </Paper>
        )}
      </PageBody>
      <JobDialog
        open={editing !== null}
        job={editing?.job ?? null}
        target={editing?.target}
        targets={targets}
        onClose={() => {
          setEditing(null);
          if (newTarget) router.replace("/jobs");
        }}
        onSaved={(j) => {
          notify(`Saved jobs/${j.id}.toml`, "success");
          void reload();
          router.refresh();
        }}
      />
      <RunParamsDialog
        job={runningWith}
        onClose={() => setRunningWith(null)}
        onRun={(params) => {
          const j = runningWith!;
          setRunningWith(null);
          start(j, params);
        }}
      />
      <Dialog open={removing !== null} onClose={() => setRemoving(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete {removing?.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>Its file (jobs/{removing?.id}.toml) and run history are deleted. What it runs ({removing?.tasks.length === 1 ? removing.tasks[0].target : `${removing?.tasks.length} tasks`}) stays.</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoving(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              const j = removing!;
              setRemoving(null);
              act(async () => {
                unwrap(await removeJob(j.id));
                router.refresh();
              });
            }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
