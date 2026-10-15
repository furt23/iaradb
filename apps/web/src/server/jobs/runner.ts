import "server-only";

import { isFinished, type JobRun, type JobSpec, type Params, type RunTrigger } from "@/lib/jobs";

import { jobClusterLease } from "./jobCluster";
import { notifyRun } from "./notify";
import { executeRun, type RunDeps } from "./orchestrator";
import { appendLog, appendTaskLog, listRuns, saveRun, saveTaskRun } from "./runs";
import { runTask } from "./taskRunner";

/**
 * Starting and cancelling job runs. The run itself (the tasks as a DAG) is
 * the orchestrator's; each task is the task runner's; the cluster is shared
 * by all tasks of a run and goes with it.
 */

interface Active {
  run: JobRun;
  controller: AbortController;
}

const g = globalThis as { __iaraJobRuns?: Map<string, Active> };
const active = (g.__iaraJobRuns ??= new Map());

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function depsOf(spec: JobSpec, a: Active): RunDeps {
  const log = (text: string) => appendLog(a.run.job, a.run.id, text);
  return {
    runTask,
    cluster: jobClusterLease(spec, a.run.id, (t) => log(`[${new Date().toISOString().slice(11, 19)}] ${t}\n`)),
    store: {
      saveRun: (run) => {
        a.run = run;
        saveRun(run);
      },
      saveTaskRun: (job, run, task) => void saveTaskRun(job, run, task),
      log,
      taskLog: appendTaskLog,
    },
    notify: (s, run, event) => notifyRun(s, run, event),
    sleep,
    timer: (ms, fn) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    now: () => Date.now(),
  };
}

/** The run of a job going on now, if any. */
export function activeRun(job: string): JobRun | undefined {
  return [...active.values()].find((a) => a.run.job === job && !isFinished(a.run.status))?.run;
}

/** Start a run (it goes on in the background); one run of a job at a time. `params` win over the job's and the tasks' params. */
export function startRun(spec: JobSpec, trigger: RunTrigger, params?: Params): JobRun {
  if (activeRun(spec.id)) throw new Error(`${spec.name} is already running`);
  const run: JobRun = {
    id: `r-${Date.now().toString(36)}-${Math.floor(Math.random() * 46656).toString(36)}`,
    job: spec.id,
    trigger,
    status: "starting",
    startedAt: Date.now(),
  };
  const a: Active = { run, controller: new AbortController() };
  active.set(run.id, a);
  saveRun(run);
  void executeRun(spec, run, depsOf(spec, a), { params, signal: a.controller.signal }).finally(() => active.delete(run.id));
  return run;
}

export async function cancelRun(runId: string): Promise<void> {
  const a = active.get(runId);
  if (a && !isFinished(a.run.status)) a.controller.abort("cancelled by hand");
}

/** Runs left "running" by a Studio that stopped mid-run. */
export function settleInterrupted(job: string): void {
  for (const r of listRuns(job)) {
    if (!isFinished(r.status) && !active.has(r.id)) saveRun({ ...r, status: "failed", error: "the Studio stopped during the run", endedAt: r.endedAt ?? Date.now() });
  }
}
