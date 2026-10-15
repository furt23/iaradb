import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JobRun, TaskRun } from "@/lib/jobs";

import {
  appendLog,
  appendTaskLog,
  listRuns,
  readLog,
  readTaskLog,
  saveRun,
  saveTaskRun,
  taskLogPath,
  tasksOf,
} from "./runs";

function run(id: string, startedAt: number, extra: Partial<JobRun> = {}): JobRun {
  return { id, job: "nightly", trigger: "manual", status: "succeeded", startedAt, ...extra };
}

function task(key: string, attempt: number, status: TaskRun["status"] = "running"): TaskRun {
  return { key, status, attempt };
}

describe("run history", () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
    previous = process.env.IARA_STUDIO_DATA;
    process.env.IARA_STUDIO_DATA = dir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.IARA_STUDIO_DATA;
    else process.env.IARA_STUDIO_DATA = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("taskLogPath", () => {
    it("names the file after the run, the task and the attempt, next to the run's log", () => {
      expect(taskLogPath("nightly", "r-abc-1", "load", 2)).toBe(path.join(dir, "jobs", "nightly", "r-abc-1.load.2.log"));
    });

    it("refuses names that could leave the job's folder", () => {
      expect(() => taskLogPath("nightly", "../r", "load", 1)).toThrow(/invalid run id/);
      expect(() => taskLogPath("nightly", "r-1.x", "load", 1)).toThrow(/invalid run id/);
      expect(() => taskLogPath("nightly", "r-1", "../load", 1)).toThrow(/invalid task key/);
      expect(() => taskLogPath("nightly", "r-1", "a/b", 1)).toThrow(/invalid task key/);
      expect(() => taskLogPath("nightly", "r-1", "load", 0)).toThrow(/invalid attempt/);
      expect(() => taskLogPath("nightly", "r-1", "load", 1.5)).toThrow(/invalid attempt/);
    });
  });

  describe("task logs", () => {
    it("reads the latest attempt when none is given", () => {
      appendTaskLog("nightly", "r-1", "load", 1, "first try\n");
      appendTaskLog("nightly", "r-1", "load", 2, "second try\n");
      expect(readTaskLog("nightly", "r-1", "load")).toBe("second try\n");
      expect(readTaskLog("nightly", "r-1", "load", 1)).toBe("first try\n");
    });

    it("keeps each task's log apart and returns an empty text when there is none", () => {
      appendTaskLog("nightly", "r-1", "load", 1, "load\n");
      appendTaskLog("nightly", "r-1", "load_all", 1, "load_all\n");
      appendTaskLog("nightly", "r-10", "load", 1, "other run\n");
      expect(readTaskLog("nightly", "r-1", "load")).toBe("load\n");
      expect(readTaskLog("nightly", "r-1", "report")).toBe("");
      expect(readTaskLog("nightly", "r-1", "load", 7)).toBe("");
      expect(readTaskLog("nightly", "r-1", "../load")).toBe("");
    });

    it("keeps the job-level log as it was", () => {
      appendLog("nightly", "r-1", "run line\n");
      appendTaskLog("nightly", "r-1", "load", 1, "task line\n");
      expect(readLog("nightly", "r-1")).toBe("run line\n");
    });
  });

  describe("tasks in runs.json", () => {
    it("loads runs written before tasks", () => {
      const folder = path.join(dir, "jobs", "nightly");
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "runs.json"), JSON.stringify([run("r-old", 1, { status: "failed", error: "boom" })]));
      const [old] = listRuns("nightly");
      expect(old.id).toBe("r-old");
      expect(old.tasks).toBeUndefined();
      expect(tasksOf(old)).toEqual([]);
    });

    it("saves each task of a run, and updates it in place", () => {
      saveRun(run("r-1", 1, { status: "running" }));
      expect(saveTaskRun("nightly", "r-1", task("load", 1))).toBe(true);
      expect(saveTaskRun("nightly", "r-1", task("report", 1, "pending"))).toBe(true);
      expect(saveTaskRun("nightly", "r-1", task("load", 2, "succeeded"))).toBe(true);
      expect(tasksOf(listRuns("nightly")[0])).toEqual([task("load", 2, "succeeded"), task("report", 1, "pending")]);
    });

    it("says so when the run is not there", () => {
      expect(saveTaskRun("nightly", "r-missing", task("load", 1))).toBe(false);
    });

    it("keeps the tasks of a run saved without them", () => {
      saveRun(run("r-1", 1, { status: "running", tasks: [task("load", 1, "succeeded")] }));
      saveRun(run("r-1", 1, { status: "succeeded" }));
      expect(tasksOf(listRuns("nightly")[0])).toEqual([task("load", 1, "succeeded")]);
    });

    it("drops the logs of the task attempts of runs beyond the last 100", () => {
      saveRun(run("r-0", 0));
      appendTaskLog("nightly", "r-0", "load", 1, "old\n");
      for (let i = 1; i <= 100; i++) saveRun(run(`r-${i}`, i));
      expect(listRuns("nightly")).toHaveLength(100);
      expect(readTaskLog("nightly", "r-0", "load")).toBe("");
      expect(fs.existsSync(taskLogPath("nightly", "r-0", "load", 1))).toBe(false);
    });
  });
});
