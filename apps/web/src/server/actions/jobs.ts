"use server";

import { checkJob, jobId, nextScheduled, type JobRun, type JobSpec, type Params } from "@/lib/jobs";

import { requireUser } from "../auth/session";
import { deleteJob, freeJobId, listJobs, readJob, writeJob, type JobProblem } from "../jobs/files";
import { activeRun, cancelRun, startRun } from "../jobs/runner";
import { forgetJob, listRuns, readLog, readTaskLog } from "../jobs/runs";
import { startScheduler } from "../jobs/scheduler";
import { attempt, type ActionResult } from "../result";

export interface JobView extends JobSpec {
  lastRun: JobRun | null;
  nextRun: number | null;
}

export async function jobsOverview(): Promise<ActionResult<{ jobs: JobView[]; problems: JobProblem[] }>> {
  return attempt(async () => {
    await requireUser();
    startScheduler();
    const { jobs, problems } = await listJobs();
    const now = new Date();
    const views = jobs.map((j) => ({ ...j, lastRun: activeRun(j.id) ?? listRuns(j.id)[0] ?? null, nextRun: nextScheduled(j, now) }));
    return { jobs: views, problems };
  });
}

export type JobInput = Omit<JobSpec, "id"> & { id?: string };

/** Create a job (no `id`) or change one. */
export async function saveJob(input: JobInput): Promise<ActionResult<JobSpec>> {
  return attempt(async () => {
    await requireUser();
    const id = input.id ?? (await freeJobId(jobId(input.name)));
    return writeJob(checkJob({ ...input, id, name: input.name.trim() || id }));
  });
}

export async function setJobEnabled(id: string, enabled: boolean): Promise<ActionResult<JobSpec>> {
  return attempt(async () => {
    await requireUser();
    const job = await readJob(id);
    return writeJob({ ...job, enabled });
  });
}

export async function removeJob(id: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    if (activeRun(id)) throw new Error("the job is running: cancel its run first");
    await deleteJob(id);
    forgetJob(id);
    return null;
  });
}

/** Start a run by hand; `params` (optional) win over the params of the job and its tasks for this run. */
export async function runJobNow(id: string, params?: Params): Promise<ActionResult<JobRun>> {
  return attempt(async () => {
    await requireUser();
    const job = await readJob(id);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw new Error(`param ${k} is a string, a number or a boolean`);
    }
    return startRun(job, "manual", params && Object.keys(params).length ? params : undefined);
  });
}

export async function cancelJobRun(runId: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    await cancelRun(runId);
    return null;
  });
}

export async function jobDetail(id: string): Promise<ActionResult<{ job: JobView; runs: JobRun[] }>> {
  return attempt(async () => {
    await requireUser();
    const job = await readJob(id);
    const runs = listRuns(id);
    const live = activeRun(id);
    const all = live ? [live, ...runs.filter((r) => r.id !== live.id)] : runs;
    return { job: { ...job, lastRun: all[0] ?? null, nextRun: nextScheduled(job, new Date()) }, runs: all };
  });
}

export async function runLog(job: string, run: string): Promise<ActionResult<string>> {
  return attempt(async () => {
    await requireUser();
    return readLog(job, run);
  });
}

/** The log of a task of a run (the given attempt, else the latest). */
export async function taskLog(jobId: string, runId: string, taskKey: string, attemptNo?: number): Promise<ActionResult<string>> {
  return attempt(async () => {
    await requireUser();
    return readTaskLog(jobId, runId, taskKey, attemptNo);
  });
}
