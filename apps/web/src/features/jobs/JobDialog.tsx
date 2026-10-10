"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { useEffect, useRef, useState } from "react";

import { useCompute } from "@/features/compute/ComputeProvider";
import { useGuard } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { DEFAULT_TIMEOUT_MINUTES, JOB_CLUSTER, type JobSpec } from "@/lib/jobs";
import { baseName } from "@/lib/paths";
import { saveJob } from "@/server/actions/jobs";
import { DEFAULT_INSTANCE_TYPE } from "@/server/compute/instanceTypes";

import { ScheduleFields } from "./ScheduleFields";
import { fromCron, toCron, type ScheduleForm } from "./scheduleForm";

interface Draft {
  name: string;
  target: string;
  cluster: string;
  instanceType: string;
  timeout: number;
  schedule: ScheduleForm;
}

function draftOf(job: JobSpec | null, target: string | undefined, defaultCluster: string): Draft {
  if (job) {
    return {
      name: job.name,
      target: job.target,
      cluster: job.cluster,
      instanceType: job.instanceType ?? DEFAULT_INSTANCE_TYPE,
      timeout: job.timeoutMinutes,
      schedule: fromCron(job.schedule),
    };
  }
  const t = target ?? "";
  return {
    name: t ? baseName(t).replace(/\.(py|sql)$/i, "").replace(/_/g, " ") : "",
    target: t,
    cluster: defaultCluster,
    instanceType: DEFAULT_INSTANCE_TYPE,
    timeout: DEFAULT_TIMEOUT_MINUTES,
    schedule: fromCron(null),
  };
}

/** Create a job, or change one: what runs, when, and on which cluster. */
export function JobDialog({ open, job, target, targets, onClose, onSaved }: { open: boolean; job: JobSpec | null; target?: string; targets: string[]; onClose(): void; onSaved(job: JobSpec): void }) {
  const { overview } = useCompute();
  const clusters = (overview?.clusters ?? []).filter((c) => !c.job);
  // without AWS, runs go to an existing cluster (Local, in development)
  const defaultCluster = overview?.cloud || !clusters.length ? JOB_CLUSTER : clusters[0].name;
  const [d, setD] = useState<Draft>(() => draftOf(job, target, defaultCluster));
  const fallback = useRef(defaultCluster);
  fallback.current = defaultCluster;
  /** the cluster was picked (by hand, or by an existing job) */
  const picked = useRef(false);
  const [busy, setBusy] = useState(false);
  const guard = useGuard();
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  useEffect(() => {
    if (!open) return;
    picked.current = job !== null;
    setD(draftOf(job, target, fallback.current));
  }, [open, job, target]);

  // a new job follows the default until a cluster is picked (the clusters may load after the dialog opens)
  useEffect(() => {
    if (open && !picked.current) setD((x) => (x.cluster === defaultCluster ? x : { ...x, cluster: defaultCluster }));
  }, [open, defaultCluster]);

  const save = async () => {
    setBusy(true);
    const saved = await guard(async () =>
      unwrap(
        await saveJob({
          id: job?.id,
          name: d.name,
          target: d.target,
          schedule: toCron(d.schedule),
          cluster: d.cluster,
          instanceType: d.cluster === JOB_CLUSTER ? d.instanceType : null,
          timeoutMinutes: d.timeout,
          enabled: job?.enabled ?? true,
        }),
      ),
    );
    setBusy(false);
    if (saved) {
      onSaved(saved);
      onClose();
    }
  };

  const jobCluster = d.cluster === JOB_CLUSTER;
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{job ? `Edit ${job.name}` : "New job"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.25} sx={{ mt: 1 }}>
          <TextField label="Name" value={d.name} onChange={(e) => set({ name: e.target.value })} autoFocus={!target} />
          <TextField select label="Runs" value={d.target} onChange={(e) => set({ target: e.target.value })} helperText="A notebook (every cell, in order) or a query file (each statement)">
            {[...new Set([...targets, ...(d.target ? [d.target] : [])])].map((t) => (
              <MenuItem key={t} value={t}>
                {t}
              </MenuItem>
            ))}
          </TextField>
          <ScheduleFields form={d.schedule} onChange={(schedule) => set({ schedule })} />
          <Stack direction="row" spacing={1.5}>
            <TextField
              select
              label="Cluster"
              value={d.cluster}
              onChange={(e) => {
                picked.current = true;
                set({ cluster: e.target.value });
              }}
              sx={{ flex: 1 }}
              helperText={jobCluster ? (overview?.cloud ? "Made for each run, terminated after it" : "AWS is not configured: job clusters cannot start") : "Started if it is not running"}
            >
              <MenuItem value={JOB_CLUSTER}>A new cluster for each run</MenuItem>
              {clusters.map((c) => (
                <MenuItem key={c.id} value={c.name}>
                  {c.name}
                </MenuItem>
              ))}
            </TextField>
            {jobCluster && (
              <TextField select label="Machine" value={d.instanceType} onChange={(e) => set({ instanceType: e.target.value })} sx={{ flex: 1 }}>
                {(overview?.instanceTypes.length ? overview.instanceTypes : [{ name: d.instanceType, vcpus: 0, memoryGib: 0 }]).map((t) => (
                  <MenuItem key={t.name} value={t.name}>
                    {t.vcpus ? `${t.name} · ${t.vcpus} vCPU · ${t.memoryGib} GiB` : t.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
          </Stack>
          <TextField
            label="Timeout (minutes)"
            type="number"
            value={d.timeout}
            onChange={(e) => set({ timeout: Number(e.target.value) })}
            helperText="A run still going after this is cancelled"
            sx={{ width: 220 }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => void save()} disabled={busy || !d.target || !d.name.trim()}>
          {job ? "Save" : "Create"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
