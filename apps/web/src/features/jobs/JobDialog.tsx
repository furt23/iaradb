"use client";

import Add from "@mui/icons-material/Add";
import ExpandMore from "@mui/icons-material/ExpandMore";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useMemo, useRef, useState } from "react";

import { useCompute } from "@/features/compute/ComputeProvider";
import { useGuard } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { DEFAULT_TIMEOUT_MINUTES, JOB_CLUSTER, MAIN_TASK, type JobSpec } from "@/lib/jobs";
import { baseName } from "@/lib/paths";
import { saveJob } from "@/server/actions/jobs";
import { DEFAULT_INSTANCE_TYPE } from "@/server/compute/instanceTypes";

import {
  blankDraft,
  checkDrafts,
  draftsOf,
  notifyDrafts,
  notifyError,
  notifyOf,
  paramsToRows,
  removeDraft,
  rowsToParams,
  type NotifyDraft,
  type ParamRow,
  type TaskDraft,
} from "./jobForm";
import { NotifyFields } from "./NotifyFields";
import { ParamRows } from "./ParamRows";
import { ScheduleFields } from "./ScheduleFields";
import { fromCron, toCron, type ScheduleForm } from "./scheduleForm";
import { TaskEditor } from "./TaskEditor";
import { TaskGraph } from "./TaskGraph";

interface Draft {
  name: string;
  tasks: TaskDraft[];
  params: ParamRow[];
  notify: NotifyDraft[];
  cluster: string;
  instanceType: string;
  timeout: number;
  schedule: ScheduleForm;
}

function draftOf(job: JobSpec | null, target: string | undefined, defaultCluster: string): Draft {
  if (job) {
    return {
      name: job.name,
      tasks: draftsOf(job.tasks),
      params: paramsToRows(job.params),
      notify: notifyDrafts(job.notify),
      cluster: job.cluster,
      instanceType: job.instanceType ?? DEFAULT_INSTANCE_TYPE,
      timeout: job.timeoutMinutes,
      schedule: fromCron(job.schedule),
    };
  }
  const t = target ?? "";
  return {
    name: t ? baseName(t).replace(/\.(py|sql)$/i, "").replace(/_/g, " ") : "",
    tasks: [{ ...blankDraft([], t), key: MAIN_TASK }],
    params: [],
    notify: [],
    cluster: defaultCluster,
    instanceType: DEFAULT_INSTANCE_TYPE,
    timeout: DEFAULT_TIMEOUT_MINUTES,
    schedule: fromCron(null),
  };
}

/** Create a job, or change one: what runs (a task or a graph of tasks), when, and on which cluster. */
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
  /** the task just added (it takes the focus) */
  const [added, setAdded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const guard = useGuard();
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const setTask = (id: string, patch: Partial<TaskDraft>) => setD((x) => ({ ...x, tasks: x.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));

  useEffect(() => {
    if (!open) return;
    picked.current = job !== null;
    setAdded(null);
    setD(draftOf(job, target, fallback.current));
  }, [open, job, target]);

  // a new job follows the default until a cluster is picked (the clusters may load after the dialog opens)
  useEffect(() => {
    if (open && !picked.current) setD((x) => (x.cluster === defaultCluster ? x : { ...x, cluster: defaultCluster }));
  }, [open, defaultCluster]);

  const check = useMemo(() => checkDrafts(d.tasks), [d.tasks]);
  const jobParams = useMemo(() => rowsToParams(d.params), [d.params]);
  const notifyBad = d.notify.some((n) => notifyError(n) !== null);
  const timeoutBad = !Number.isFinite(d.timeout) || d.timeout < 1 || d.timeout > 24 * 60;
  const valid = check.valid && !jobParams.errors.length && !notifyBad && !timeoutBad && Boolean(d.name.trim());
  const single = d.tasks.length === 1;

  const save = async () => {
    setBusy(true);
    const saved = await guard(async () =>
      unwrap(
        await saveJob({
          id: job?.id,
          name: d.name,
          tasks: check.tasks,
          params: jobParams.params,
          notify: notifyOf(d.notify),
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

  const addTask = () => {
    const t = blankDraft(d.tasks);
    setAdded(t.id);
    set({ tasks: [...d.tasks, t] });
  };

  const jobCluster = d.cluster === JOB_CLUSTER;
  const advancedOpen = job !== null && (job.notify.length > 0 || Object.keys(job.params).length > 0);
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth={single ? "sm" : "md"}>
      <DialogTitle>{job ? `Edit ${job.name}` : "New job"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.25} sx={{ mt: 1 }}>
          <TextField label="Name" value={d.name} onChange={(e) => set({ name: e.target.value })} autoFocus={!target} />

          {single ? (
            <TaskEditor
              draft={d.tasks[0]}
              others={[]}
              targets={targets}
              single
              errors={check.fields[d.tasks[0].id]}
              onChange={(p) => setTask(d.tasks[0].id, p)}
              onRemove={() => undefined}
            />
          ) : (
            <Stack spacing={1.25} role="group" aria-label="tasks">
              <Typography sx={{ fontWeight: 650, fontSize: 13 }}>Tasks</Typography>
              {d.tasks.map((t) => (
                <TaskEditor
                  key={t.id}
                  draft={t}
                  others={d.tasks.filter((o) => o.id !== t.id)}
                  targets={targets}
                  single={false}
                  errors={check.fields[t.id]}
                  autoFocus={t.id === added}
                  onChange={(p) => setTask(t.id, p)}
                  onRemove={() => set({ tasks: removeDraft(d.tasks, t.id) })}
                />
              ))}
            </Stack>
          )}
          <Button size="small" startIcon={<Add />} onClick={addTask} sx={{ alignSelf: "flex-start", mt: "4px !important" }}>
            {single ? "Add another task" : "Add task"}
          </Button>
          {check.dagErrors.length > 0 && (
            <Alert severity="error" role="alert" aria-label="task errors">
              {check.dagErrors.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </Alert>
          )}
          {!single && check.tasks.length > 0 && (
            <Paper variant="outlined" sx={{ p: 1, bgcolor: "action.hover" }} aria-label="graph preview">
              <TaskGraph tasks={check.tasks} scale={0.6} />
            </Paper>
          )}

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
              helperText={jobCluster ? (overview?.cloud ? undefined : "AWS is not configured: job clusters cannot start") : "Started if it is not running"}
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
            error={timeoutBad}
            helperText={timeoutBad ? "A whole number from 1 to 1440" : "A run still going after this is cancelled"}
            sx={{ width: 220 }}
          />
          <Accordion disableGutters elevation={0} square defaultExpanded={advancedOpen} sx={{ border: 0, "&:before": { display: "none" }, bgcolor: "transparent" }}>
            <AccordionSummary expandIcon={<ExpandMore />} sx={{ px: 0, minHeight: 36, "& .MuiAccordionSummary-content": { my: 0.5 } }}>
              <Typography sx={{ fontSize: 13, color: "text.secondary" }}>Job params and notifications</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 0, pt: 0.5 }}>
              <Stack spacing={2.25}>
                <Box>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: 0.75 }}>Params</Typography>
                  <ParamRows label="Job params" rows={d.params} onChange={(params) => set({ params })} errors={jobParams.errors} />
                </Box>
                <Box>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: 0.75 }}>Notifications</Typography>
                  <NotifyFields rows={d.notify} onChange={(notify) => set({ notify })} />
                </Box>
              </Stack>
            </AccordionDetails>
          </Accordion>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => void save()} disabled={busy || !valid}>
          {job ? "Save" : "Create"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
