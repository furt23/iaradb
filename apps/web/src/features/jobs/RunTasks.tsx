"use client";

import Box from "@mui/material/Box";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import { isTaskFinished } from "@/lib/jobDag";
import { formatDuration, formatRelative } from "@/lib/format";
import { isFinished, taskOf, type JobRun, type JobSpec, type TaskRun } from "@/lib/jobs";
import { taskLog } from "@/server/actions/jobs";

import { LogText } from "./RunLog";
import { RunStatusChip } from "./RunStatusChip";
import { TaskGraph } from "./TaskGraph";
import { firstTask } from "./taskStatus";

function TaskLog({ job, run, task, live }: { job: string; run: string; task: TaskRun; live: boolean }) {
  // the latest attempt unless one is picked
  const [attempt, setAttempt] = useState<number | null>(null);
  const shown = attempt !== null && attempt <= task.attempt ? attempt : task.attempt;
  return (
    <Paper variant="outlined" sx={{ mt: 2 }}>
      <Box sx={{ px: 2, py: 1, borderBottom: 1, borderColor: "divider", display: "flex", gap: 1, alignItems: "center" }}>
        <Typography sx={{ fontWeight: 650, fontSize: 13 }}>Task {task.key}</Typography>
        <RunStatusChip status={task.status} kind="task" />
        {task.attempt > 1 && (
          <TextField select size="small" value={shown} onChange={(e) => setAttempt(Number(e.target.value))} slotProps={{ htmlInput: { "aria-label": "attempt" } }} sx={{ ml: "auto", minWidth: 130 }}>
            {Array.from({ length: task.attempt }, (_, i) => i + 1).map((n) => (
              <MenuItem key={n} value={n}>
                Attempt {n}
                {n === task.attempt ? " (latest)" : ""}
              </MenuItem>
            ))}
          </TextField>
        )}
      </Box>
      <LogText
        load={() => taskLog(job, run, task.key, shown)}
        live={live && shown === task.attempt && !isTaskFinished(task.status)}
        label={`task log ${task.key}`}
        rev={`${job}/${run}/${task.key}/${shown}/${task.status}`}
      />
    </Paper>
  );
}

/** The tasks of a run: their graph, a table, and the log of the one picked. */
export function RunTasks({ job, run }: { job: JobSpec; run: JobRun }) {
  const tasks = run.tasks ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const key = picked && tasks.some((t) => t.key === picked) ? picked : firstTask(tasks);
  const task = tasks.find((t) => t.key === key);
  // a job edited since the run no longer has its graph: the tasks of the run, side by side
  const known = new Set(job.tasks.map((t) => t.key));
  const graph = tasks.every((t) => known.has(t.key)) ? job.tasks : tasks.map((t) => taskOf("", t.key));
  const targetOf = (k: string) => job.tasks.find((t) => t.key === k)?.target;
  const live = !isFinished(run.status);

  return (
    <>
      <Paper variant="outlined" sx={{ mt: 2, p: 1.5 }}>
        <TaskGraph tasks={graph} run={tasks} selected={key} onSelect={setPicked} />
      </Paper>
      <Paper variant="outlined" sx={{ mt: 2 }}>
        <Table size="small" aria-label="tasks">
          <TableHead>
            <TableRow>
              <TableCell>Task</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Attempt</TableCell>
              <TableCell>Started</TableCell>
              <TableCell>Took</TableCell>
              <TableCell>Error</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {tasks.map((t) => (
              <TableRow key={t.key} hover selected={t.key === key} onClick={() => setPicked(t.key)} sx={{ cursor: "pointer" }} aria-label={`task row ${t.key}`}>
                <TableCell>
                  <Typography sx={{ fontWeight: 650, fontSize: 13 }}>{t.key}</Typography>
                  {targetOf(t.key) && (
                    <Typography variant="mono" component="div" noWrap sx={{ fontSize: 11.5, color: "text.secondary" }}>
                      {targetOf(t.key)}
                    </Typography>
                  )}
                </TableCell>
                <TableCell>
                  <RunStatusChip status={t.status} kind="task" />
                </TableCell>
                <TableCell>{t.attempt}</TableCell>
                <TableCell title={t.startedAt ? new Date(t.startedAt).toLocaleString() : undefined}>{t.startedAt ? formatRelative(t.startedAt) : ""}</TableCell>
                <TableCell>{t.startedAt ? (t.endedAt ? formatDuration(t.endedAt - t.startedAt) : "…") : ""}</TableCell>
                <TableCell sx={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "error.main" }} title={t.error}>
                  {t.error ?? ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
      {task && <TaskLog key={task.key} job={run.job} run={run.id} task={task} live={live} />}
    </>
  );
}
