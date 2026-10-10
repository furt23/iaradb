import "server-only";

import { due } from "@/lib/jobs";

import { listJobs } from "./files";
import { activeRun, settleInterrupted, startRun } from "./runner";
import { firedAt, setFiredAt } from "./runs";

/**
 * Starts scheduled jobs: every half minute, each enabled job whose schedule
 * fired since it last ran starts (once, however many times it fired while
 * the Studio was down; a run still going on is not doubled).
 */

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
      const { jobs } = await listJobs();
      const fired = firedAt();
      const now = this.now();
      for (const job of jobs) {
        if (first) settleInterrupted(job.id);
        const when = due(job, fired[job.id], now);
        if (fired[job.id] === undefined) fired[job.id] = now.getTime();
        if (when === null) continue;
        fired[job.id] = when;
        if (activeRun(job.id)) continue;
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

const g = globalThis as { __workhouseScheduler?: Scheduler };

/** Started once per server (see instrumentation.ts). */
export function startScheduler(): Scheduler {
  return (g.__workhouseScheduler ??= new Scheduler().start());
}
