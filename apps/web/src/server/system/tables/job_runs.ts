import fs from "node:fs";
import path from "node:path";

import { dataDir } from "../../compute/store";
import { listRuns, tasksOf } from "../../jobs/runs";
import type { SystemTable } from "./index";

/** Every run of every job, dashboard refreshes included (their jobs are `dashboard-<id>`). */
export const jobRuns: SystemTable = {
  name: "job_runs",
  columns: [
    ["id", "string"],
    ["job", "string"],
    ["trigger", "string"],
    ["status", "string"],
    ["started_at", "timestamp"],
    ["ended_at", "timestamp"],
    ["cluster", "string"],
    ["error", "string"],
    ["summary", "string"],
    ["tasks", "int"],
  ],
  async rows() {
    const root = path.join(dataDir(), "jobs");
    let jobs: string[];
    try {
      jobs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
    return jobs.flatMap((job) =>
      listRuns(job).map((run) => ({
        id: run.id,
        job: run.job,
        trigger: run.trigger,
        status: run.status,
        started_at: run.startedAt,
        ended_at: run.endedAt ?? null,
        cluster: run.cluster ?? "",
        error: run.error ?? "",
        summary: run.summary ?? "",
        tasks: tasksOf(run).length,
      })),
    );
  },
};
