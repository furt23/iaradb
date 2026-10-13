import { describe, expect, it } from "vitest";

import { taskOf, type JobRun, type JobSpec, type NotifyEvent, type Params, type TaskRun, type TaskSpec } from "@/lib/jobs";

import { backoffMs, executeRun, type RunDeps, type RunOptions, type TaskInput, type TaskOutcome } from "./orchestrator";

const task = (key: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({ ...taskOf(`notebooks/${key}.py`, key), ...extra });

function specOf(tasks: TaskSpec[], extra: Partial<JobSpec> = {}): JobSpec {
  return { id: "nightly", name: "Nightly", tasks, params: {}, notify: [], schedule: null, cluster: "job", instanceType: null, timeoutMinutes: 60, enabled: true, ...extra };
}

const RUN: JobRun = { id: "r-1", job: "nightly", trigger: "manual", status: "starting", startedAt: 0 };

type Behavior = (input: TaskInput) => Promise<TaskOutcome> | TaskOutcome;

/** A deferred promise a test settles by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

/** Let the run loop go on (the fakes resolve on microtasks). */
const settle = () => new Promise<void>((r) => setTimeout(r, 5));

function harness(behavior: Behavior, extra: { acquire?: () => Promise<{ id: string; name: string }> } = {}) {
  const calls: TaskInput[] = [];
  const order: string[] = [];
  const sleeps: number[] = [];
  const events: NotifyEvent[] = [];
  const jobLog: string[] = [];
  const taskLogs: string[] = [];
  const saved: JobRun[] = [];
  const savedTasks: TaskRun[] = [];
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const released: number[] = [];
  let clock = 0;
  const deps: RunDeps = {
    runTask: async (input) => {
      calls.push(input);
      order.push(`start:${input.task.key}`);
      const out = await behavior(input);
      order.push(`end:${input.task.key}`);
      return out;
    },
    cluster: { acquire: extra.acquire ?? (async () => ({ id: "c-1", name: "job-r-1" })), release: async () => void released.push(1) },
    store: {
      saveRun: (r) => void saved.push(r),
      saveTaskRun: (_j, _r, t) => void savedTasks.push(t),
      log: (t) => void jobLog.push(t),
      taskLog: (_j, _r, key, attempt, text) => void taskLogs.push(`${key}.${attempt}:${text}`),
    },
    notify: async (_s, _r, event) => void events.push(event),
    sleep: async (ms) => void (sleeps.push(ms), (clock += ms)),
    timer: (ms, fn) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => (t.cancelled = true);
    },
    now: () => clock,
  };
  const run = (spec: JobSpec, options?: RunOptions) => executeRun(spec, RUN, deps, options);
  const statuses = (r: JobRun) => Object.fromEntries((r.tasks ?? []).map((t) => [t.key, t.status]));
  return { run, calls, order, sleeps, events, jobLog, taskLogs, saved, savedTasks, timers, released, statuses };
}

const ok: Behavior = () => ({ status: "succeeded", summary: "done" });

/** A task that ends cancelled when the run aborts. */
const untilAborted: Behavior = (i) =>
  new Promise<TaskOutcome>((resolve) => {
    i.signal.addEventListener("abort", () => resolve({ status: "cancelled", error: String(i.signal.reason) }));
  });

describe("executeRun", () => {
  it("runs a linear chain in order", async () => {
    const h = harness(ok);
    const r = await h.run(specOf([task("a"), task("b", { dependsOn: ["a"] }), task("c", { dependsOn: ["b"] })]));
    expect(r.status).toBe("succeeded");
    expect(h.order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    expect(r.summary).toBe("3 of 3 tasks succeeded");
    expect(r.cluster).toBe("job-r-1");
    expect(r.endedAt).toBeDefined();
    expect(h.events).toEqual(["start", "success"]);
    expect(h.released).toHaveLength(1);
  });

  it("runs a diamond with the middle in parallel and the join last", async () => {
    const g = gate();
    const h = harness(async (i) => {
      if (i.task.key === "b") await g.promise;
      if (i.task.key === "c") g.open();
      return { status: "succeeded" };
    });
    const r = await h.run(specOf([task("a"), task("b", { dependsOn: ["a"] }), task("c", { dependsOn: ["a"] }), task("d", { dependsOn: ["b", "c"] })]));
    expect(r.status).toBe("succeeded");
    expect(h.order.indexOf("start:c")).toBeLessThan(h.order.indexOf("end:b"));
    expect(h.order.slice(-2)).toEqual(["start:d", "end:d"]);
  });

  it("marks downstream tasks upstream_failed after a failure", async () => {
    const h = harness((i) => (i.task.key === "a" ? { status: "failed", error: "boom" } : { status: "succeeded" }));
    const r = await h.run(specOf([task("a"), task("b", { dependsOn: ["a"] }), task("c", { dependsOn: ["b"] }), task("x")]));
    expect(h.statuses(r)).toEqual({ a: "failed", b: "upstream_failed", c: "upstream_failed", x: "succeeded" });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("boom");
    expect(h.events).toEqual(["start", "failure"]);
  });

  it("runs an all_done task after a failure", async () => {
    const h = harness((i) => (i.task.key === "a" ? { status: "failed", error: "boom" } : { status: "succeeded" }));
    const r = await h.run(specOf([task("a"), task("cleanup", { dependsOn: ["a"], runIf: "all_done" })]));
    expect(h.statuses(r)).toEqual({ a: "failed", cleanup: "succeeded" });
    expect(r.status).toBe("failed");
  });

  it("skips a task whose run_if is not met without failing the run", async () => {
    const h = harness(ok);
    const r = await h.run(specOf([task("a"), task("alert", { dependsOn: ["a"], runIf: "all_failed" })]));
    expect(h.statuses(r)).toEqual({ a: "succeeded", alert: "skipped" });
    expect(r.status).toBe("succeeded");
    expect(r.summary).toBe("1 of 2 tasks succeeded (1 skipped)");
  });

  it("retries with backoff and succeeds on the second attempt", async () => {
    const h = harness((i) => (i.attempt === 1 ? { status: "failed", error: "flaky" } : { status: "succeeded" }));
    const r = await h.run(specOf([task("a", { maxRetries: 2, retryBackoffSeconds: 5 })]));
    expect(r.status).toBe("succeeded");
    expect(h.calls.map((c) => c.attempt)).toEqual([1, 2]);
    expect(h.sleeps).toEqual([5000]);
    expect(r.tasks?.[0]).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(r.tasks?.[0].error).toBeUndefined();
  });

  it("gives up after maxRetries, doubling the wait up to the cap", async () => {
    const h = harness(() => ({ status: "failed", error: "no" }));
    const r = await h.run(specOf([task("a", { maxRetries: 3, retryBackoffSeconds: 200 })]));
    expect(r.status).toBe("failed");
    expect(h.calls).toHaveLength(4);
    expect(h.sleeps).toEqual([200_000, 400_000, 600_000]);
    expect(r.tasks?.[0]).toMatchObject({ status: "failed", attempt: 4, error: "no" });
    expect(backoffMs({ retryBackoffSeconds: 30 }, 3)).toBe(120_000);
  });

  it("respects the concurrency limit", async () => {
    let now = 0;
    let max = 0;
    const gates: (() => void)[] = [];
    const h = harness(async () => {
      max = Math.max(max, ++now);
      await new Promise<void>((r) => gates.push(r));
      now--;
      return { status: "succeeded" };
    });
    const p = h.run(specOf(["a", "b", "c", "d", "e"].map((k) => task(k))), { concurrency: 2 });
    for (let i = 0; i < 5; i++) {
      await settle();
      expect(now).toBeLessThanOrEqual(2);
      gates.splice(0).forEach((r) => r());
    }
    const r = await p;
    expect(r.status).toBe("succeeded");
    expect(max).toBe(2);
    expect(h.calls).toHaveLength(5);
  });

  it("runs at most 4 tasks at once by default", async () => {
    let now = 0;
    let max = 0;
    const gates: (() => void)[] = [];
    const h = harness(async () => {
      max = Math.max(max, ++now);
      await new Promise<void>((r) => gates.push(r));
      now--;
      return { status: "succeeded" };
    });
    const p = h.run(specOf(Array.from({ length: 7 }, (_, i) => task(`t${i}`))));
    for (let i = 0; i < 4; i++) {
      await settle();
      gates.splice(0).forEach((r) => r());
    }
    await p;
    expect(max).toBe(4);
  });

  it("cancels mid-run: running tasks get the abort, pending ones are cancelled", async () => {
    const abort = new AbortController();
    const h = harness(untilAborted);
    const p = h.run(specOf([task("a"), task("b", { dependsOn: ["a"] })]), { signal: abort.signal });
    await settle();
    abort.abort("cancelled by hand");
    const r = await p;
    expect(h.statuses(r)).toEqual({ a: "cancelled", b: "cancelled" });
    expect(r.status).toBe("cancelled");
    expect(r.error).toBe("cancelled by hand");
    expect(h.calls).toHaveLength(1);
    expect(h.events).toEqual(["start", "failure"]);
    expect(h.released).toHaveLength(1);
  });

  it("cancels the run when the job timeout fires", async () => {
    const h = harness(untilAborted);
    const p = h.run(specOf([task("a"), task("b", { dependsOn: ["a"] })], { timeoutMinutes: 5 }));
    await settle();
    expect(h.timers[0].ms).toBe(5 * 60_000);
    h.timers[0].fn();
    const r = await p;
    expect(r.status).toBe("cancelled");
    expect(r.error).toBe("timed out after 5 min");
    expect(h.statuses(r)).toEqual({ a: "cancelled", b: "cancelled" });
    expect(h.timers[0].cancelled).toBe(true);
  });

  it("cancels while the cluster starts", async () => {
    const abort = new AbortController();
    const h = harness(ok, {
      acquire: () => new Promise((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    });
    const p = h.run(specOf([task("a")]), { signal: abort.signal });
    await settle();
    abort.abort("cancelled by hand");
    const r = await p;
    expect(r.status).toBe("cancelled");
    expect(r.error).toBe("cancelled by hand");
    expect(r.tasks?.[0].status).toBe("cancelled");
    expect(h.calls).toHaveLength(0);
  });

  it("fails an invalid DAG at once, with the errors in the log", async () => {
    const h = harness(ok);
    const r = await h.run(specOf([task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })]));
    expect(r.status).toBe("failed");
    expect(r.error).toContain("dependency cycle");
    expect(h.jobLog.join("")).toContain("dependency cycle");
    expect(h.calls).toHaveLength(0);
    expect(h.events).toEqual(["failure"]);
    expect(h.statuses(r)).toEqual({ a: "skipped", b: "skipped" });
  });

  it("fails the run when the cluster cannot start", async () => {
    const h = harness(ok, { acquire: () => Promise.reject(new Error("no capacity")) });
    const r = await h.run(specOf([task("a")]));
    expect(r.status).toBe("failed");
    expect(r.error).toBe("no capacity");
    expect(h.calls).toHaveLength(0);
  });

  it("treats a task that throws as failed", async () => {
    const h = harness(() => {
      throw new Error("kaboom");
    });
    const r = await h.run(specOf([task("a")]));
    expect(r.status).toBe("failed");
    expect(r.error).toBe("kaboom");
  });

  it("runs a legacy single-task job as before", async () => {
    const h = harness((i) => {
      i.log("cell c1 done");
      return { status: "succeeded", summary: "2 cells ran" };
    });
    const r = await h.run(specOf([taskOf("notebooks/sales.py")]));
    expect(r.status).toBe("succeeded");
    expect(r.summary).toBe("2 cells ran");
    expect(r.error).toBeUndefined();
    expect(r.tasks).toMatchObject([{ key: "main", status: "succeeded", attempt: 1, summary: "2 cells ran" }]);
    // the task's lines show in the job log too
    const log = h.jobLog.join("");
    expect(log).toContain("run r-1 of notebooks/sales.py (manual)");
    expect(log).toContain("cell c1 done");
    expect(log).toContain("succeeded: 2 cells ran");
    expect(h.taskLogs).toEqual(["main.1:[00:00:00] cell c1 done\n"]);
  });

  it("reports the error of a failed legacy job as the task's", async () => {
    const h = harness(() => ({ status: "failed", error: "2 cell(s) failed" }));
    const r = await h.run(specOf([taskOf("notebooks/sales.py")]));
    expect(r.status).toBe("failed");
    expect(r.error).toBe("2 cell(s) failed");
  });

  it("merges params: job, then task, then run-time", async () => {
    const seen: Params[] = [];
    const h = harness((i) => (seen.push(i.params), { status: "succeeded" }));
    await h.run(specOf([task("a", { params: { b: "task", c: "task" } })], { params: { a: "job", b: "job", c: "job" } }), { params: { c: "run" } });
    expect(seen).toEqual([{ a: "job", b: "task", c: "run" }]);
  });

  it("persists every task change", async () => {
    const h = harness(ok);
    await h.run(specOf([task("a"), task("b", { dependsOn: ["a"] })]));
    expect(h.savedTasks.filter((t) => t.key === "a").map((t) => t.status)).toEqual(["running", "running", "succeeded"]);
    expect(h.savedTasks.at(-1)).toMatchObject({ key: "b", status: "succeeded" });
    expect(h.saved[0].tasks?.map((t) => t.status)).toEqual(["pending", "pending"]);
    expect(h.saved.at(-1)?.status).toBe("succeeded");
  });
});
