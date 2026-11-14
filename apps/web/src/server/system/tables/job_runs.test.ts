import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saveRun, saveTaskRun } from "../../jobs/runs";
import { jobRuns } from "./job_runs";

describe("job_runs table", () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-runs-"));
    previous = process.env.IARA_STUDIO_DATA;
    process.env.IARA_STUDIO_DATA = dir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.IARA_STUDIO_DATA;
    else process.env.IARA_STUDIO_DATA = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("has no rows before any run", async () => {
    expect(await jobRuns.rows?.()).toEqual([]);
  });

  it("has one row per run of every job, dashboard refreshes included", async () => {
    saveRun({ id: "r1", job: "nightly", trigger: "schedule", status: "failed", startedAt: 1000, endedAt: 2000, cluster: "c1", error: "boom", summary: "2 cells" });
    saveRun({ id: "r2", job: "dashboard-abc", trigger: "manual", status: "succeeded", startedAt: 3000 });
    saveTaskRun("nightly", "r1", { key: "load", status: "failed", attempt: 1 });

    const rows = await jobRuns.rows?.();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          id: "r1",
          job: "nightly",
          trigger: "schedule",
          status: "failed",
          started_at: 1000,
          ended_at: 2000,
          cluster: "c1",
          error: "boom",
          summary: "2 cells",
          tasks: 1,
        },
        {
          id: "r2",
          job: "dashboard-abc",
          trigger: "manual",
          status: "succeeded",
          started_at: 3000,
          ended_at: null,
          cluster: "",
          error: "",
          summary: "",
          tasks: 0,
        },
      ]),
    );
  });
});
