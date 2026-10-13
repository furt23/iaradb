import "server-only";

import fs from "node:fs";
import path from "node:path";

import type { JobRun, TaskRun } from "@/lib/jobs";

import { dataDir } from "../compute/store";

/**
 * Run history, in the Studio's data folder (not the workspace): per job,
 * `runs.json` (newest first), one log file per run, and one log file per
 * task attempt (`<run>.<task>.<attempt>.log`).
 */

const KEEP_RUNS = 100;
const LOG_TAIL = 256 * 1024;
const TASK_KEY = /^[A-Za-z0-9_-]+$/;

function jobDir(job: string): string {
  return path.join(dataDir(), "jobs", job);
}

function runsFile(job: string): string {
  return path.join(jobDir(job), "runs.json");
}

function checkedRun(run: string): string {
  if (!/^[a-z0-9-]+$/.test(run)) throw new Error(`invalid run id ${run}`);
  return run;
}

function logFile(job: string, run: string): string {
  return path.join(jobDir(job), `${checkedRun(run)}.log`);
}

export function listRuns(job: string): JobRun[] {
  try {
    return JSON.parse(fs.readFileSync(runsFile(job), "utf8")) as JobRun[];
  } catch {
    return [];
  }
}

/** The tasks of a run (none for runs written before tasks: they have no `tasks` field). */
export function tasksOf(run: JobRun): TaskRun[] {
  return run.tasks ?? [];
}

/** Every file of a run's logs: its job log and its task logs. */
function removeRunLogs(job: string, run: string): void {
  fs.rmSync(logFile(job, run), { force: true });
  let names: string[];
  try {
    names = fs.readdirSync(jobDir(job));
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(`${run}.`) && name.endsWith(".log")) fs.rmSync(path.join(jobDir(job), name), { force: true });
  }
}

/**
 * Insert or update a run (older runs and their logs beyond the last 100 go).
 * A run saved without `tasks` keeps the tasks it had.
 */
export function saveRun(run: JobRun): void {
  const runs = listRuns(run.job);
  const previous = runs.find((r) => r.id === run.id);
  const kept = previous && run.tasks === undefined && previous.tasks ? { ...run, tasks: previous.tasks } : run;
  const all = [kept, ...runs.filter((r) => r.id !== run.id)].sort((a, b) => b.startedAt - a.startedAt);
  for (const old of all.slice(KEEP_RUNS)) removeRunLogs(old.job, old.id);
  fs.mkdirSync(jobDir(run.job), { recursive: true });
  const file = runsFile(run.job);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(all.slice(0, KEEP_RUNS), null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

/**
 * Insert or update one task of a run already saved (its state and attempt).
 * Returns false when the run is not there.
 */
export function saveTaskRun(job: string, run: string, task: TaskRun): boolean {
  const found = listRuns(job).find((r) => r.id === run);
  if (!found) return false;
  const current = tasksOf(found);
  const tasks = current.some((t) => t.key === task.key) ? current.map((t) => (t.key === task.key ? task : t)) : [...current, task];
  saveRun({ ...found, tasks });
  return true;
}

export function appendLog(job: string, run: string, text: string): void {
  fs.mkdirSync(jobDir(job), { recursive: true });
  fs.appendFileSync(logFile(job, run), text);
}

/** `<run>.<task>.<attempt>.log` in the job's folder, next to the run's own log. */
export function taskLogPath(job: string, run: string, task: string, attempt: number): string {
  checkedRun(run);
  if (!TASK_KEY.test(task)) throw new Error(`invalid task key ${task}`);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`invalid attempt ${attempt}`);
  return path.join(jobDir(job), `${run}.${task}.${attempt}.log`);
}

export function appendTaskLog(job: string, run: string, task: string, attempt: number, text: string): void {
  const file = taskLogPath(job, run, task, attempt);
  fs.mkdirSync(jobDir(job), { recursive: true });
  fs.appendFileSync(file, text);
}

/** The latest attempt of a task that has a log (null: none). */
function latestAttempt(job: string, run: string, task: string): number | null {
  let names: string[];
  try {
    names = fs.readdirSync(jobDir(job));
  } catch {
    return null;
  }
  const prefix = `${run}.${task}.`;
  const attempts = names
    .filter((n) => n.startsWith(prefix) && n.endsWith(".log"))
    .map((n) => n.slice(prefix.length, -".log".length))
    .filter((n) => /^\d+$/.test(n))
    .map(Number);
  return attempts.length ? Math.max(...attempts) : null;
}

/** The end of a task's log: the given attempt, else the latest one ("" when there is none). */
export function readTaskLog(job: string, run: string, task: string, attempt?: number): string {
  try {
    taskLogPath(job, run, task, attempt ?? 1); // checks the names before any file is looked for
    const n = attempt ?? latestAttempt(job, run, task);
    if (n === null) return "";
    return tailOf(taskLogPath(job, run, task, n));
  } catch {
    return "";
  }
}

/** The last LOG_TAIL bytes of a file, with a marker when it is longer. */
function tailOf(file: string): string {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  try {
    const n = Math.min(size, LOG_TAIL);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return (size > n ? "…\n" : "") + buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** The end of a run's log. */
export function readLog(job: string, run: string): string {
  try {
    return tailOf(logFile(job, run));
  } catch {
    return "";
  }
}

/** Forget a deleted job's runs. */
export function forgetJob(job: string): void {
  fs.rmSync(jobDir(job), { recursive: true, force: true });
}

/** When each scheduled job last fired (the scheduler's memory across restarts). */
export function firedAt(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), "jobs", "fired.json"), "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

export function setFiredAt(fired: Record<string, number>): void {
  const file = path.join(dataDir(), "jobs", "fired.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(fired));
}
