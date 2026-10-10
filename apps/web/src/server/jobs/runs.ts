import "server-only";

import fs from "node:fs";
import path from "node:path";

import type { JobRun } from "@/lib/jobs";

import { dataDir } from "../compute/store";

/**
 * Run history, in the Studio's data folder (not the workspace): per job,
 * `runs.json` (newest first) and one log file per run.
 */

const KEEP_RUNS = 100;
const LOG_TAIL = 256 * 1024;

function jobDir(job: string): string {
  return path.join(dataDir(), "jobs", job);
}

function runsFile(job: string): string {
  return path.join(jobDir(job), "runs.json");
}

function logFile(job: string, run: string): string {
  if (!/^[a-z0-9-]+$/.test(run)) throw new Error(`invalid run id ${run}`);
  return path.join(jobDir(job), `${run}.log`);
}

export function listRuns(job: string): JobRun[] {
  try {
    return JSON.parse(fs.readFileSync(runsFile(job), "utf8")) as JobRun[];
  } catch {
    return [];
  }
}

/** Insert or update a run (older runs and their logs beyond the last 100 go). */
export function saveRun(run: JobRun): void {
  const runs = listRuns(run.job).filter((r) => r.id !== run.id);
  const all = [run, ...runs].sort((a, b) => b.startedAt - a.startedAt);
  for (const old of all.slice(KEEP_RUNS)) fs.rmSync(logFile(old.job, old.id), { force: true });
  fs.mkdirSync(jobDir(run.job), { recursive: true });
  const file = runsFile(run.job);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(all.slice(0, KEEP_RUNS), null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

export function appendLog(job: string, run: string, text: string): void {
  fs.mkdirSync(jobDir(job), { recursive: true });
  fs.appendFileSync(logFile(job, run), text);
}

/** The end of a run's log. */
export function readLog(job: string, run: string): string {
  try {
    const file = logFile(job, run);
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
