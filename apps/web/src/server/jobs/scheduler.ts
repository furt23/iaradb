import "server-only";

import { due, type JobSpec } from "@/lib/jobs";

import { listPublished } from "../dashboards/publish";
import { refreshJobId, refreshJobs } from "../dashboards/refresh";
import { sourcesUnchanged } from "../dashboards/unchanged";
import { listJobs } from "./files";
import { activeRun, recordSkippedRun, settleInterrupted, startRun } from "./runner";
import { firedAt, setFiredAt } from "./runs";

/**
 * Starts scheduled jobs, and the scheduled refreshes of dashboards: every half
 * minute, each enabled one whose schedule fired since it last ran starts (once, however many times it fired while
 * the Studio was down; a run still going on is not doubled). A scheduled refresh
 * whose sources have not changed is recorded as skipped instead: no cluster starts.
 */

/** Whether a scheduled refresh of a dashboard finds its extracts current (its own sources unchanged). */
async function unchangedSinceLastRefresh(job: JobSpec): Promise<boolean> {
  const p = listPublished().find((d) => refreshJobId(d.id) === job.id);
  return p !== undefined && (await sourcesUnchanged(p));
}

const TICK_MS = 30_000;

export class Scheduler {
  private ticking = false;

  constructor(private readonly now: () => Date = () => new Date()) {}

  start(): this {
    setInterval(() => void this.tick(), TICK_MS).unref();
    void this.tick(true);
    return this;
  }

  async tick(first = false): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const started: string[] = [];
    try {
      const refreshes = await refreshJobs();
      const jobs = [...(await listJobs()).jobs, ...refreshes];
      const fired = firedAt();
      const now = this.now();
      for (const job of jobs) {
        if (first) settleInterrupted(job.id);
        const when = due(job, fired[job.id], now);
        if (fired[job.id] === undefined) fired[job.id] = now.getTime();
        if (when === null) continue;
        fired[job.id] = when;
        if (activeRun(job.id)) continue;
        if (refreshes.includes(job) && (await unchangedSinceLastRefresh(job))) {
          recordSkippedRun(job, "No source changed since the last refresh");
          continue;
        }
        startRun(job, "schedule");
        started.push(job.id);
      }
      setFiredAt(fired);
    } catch {
      // no workspace jobs folder, or a broken file: the next tick tries again
    } finally {
      this.ticking = false;
    }
    return started;
  }
}

const g = globalThis as { __iaraScheduler?: Scheduler };

/** Started once per server (see instrumentation.ts). */
export function startScheduler(): Scheduler {
  return (g.__iaraScheduler ??= new Scheduler().start());
}
