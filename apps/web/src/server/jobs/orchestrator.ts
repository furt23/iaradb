import type { JobRun, JobSpec, NotifyEvent, Params, RunStatus, TaskRun, TaskRunStatus, TaskSpec } from "@/lib/jobs";
import { readyTasks, skipStatus, validateDag } from "@/lib/jobDag";

/**
 * Running a job's tasks as a DAG: starts the tasks whose upstream tasks have
 * ended (a few at a time), retries failed ones with a growing wait, skips
 * those whose `run_if` does not hold, and settles the run. What runs a task,
 * the cluster, the clock and the storage come in as `deps`, so this is
 * testable without a kernel.
 */

/** tasks running at once */
export const MAX_PARALLEL = 4;
/** the longest wait between two attempts of a task */
export const MAX_BACKOFF_SECONDS = 600;

export interface ClusterRef {
  id: string;
  name: string;
}

/** The cluster of a run: shared by all its tasks. */
export interface ClusterLease {
  /** Make or start the cluster and wait until it runs (throws when it cannot). */
  acquire(signal: AbortSignal): Promise<ClusterRef>;
  /** Terminate it if the run made it. */
  release(): Promise<void>;
}

export interface TaskInput {
  jobId: string;
  runId: string;
  task: TaskSpec;
  /** 1 for the first try */
  attempt: number;
  /** the job's params, over them the task's, over them the run's */
  params: Params;
  cluster: ClusterRef;
  /** aborted when the run is cancelled or times out */
  signal: AbortSignal;
  /** one line of the task's log */
  log: (text: string) => void;
}

export interface TaskOutcome {
  status: "succeeded" | "failed" | "cancelled";
  error?: string;
  summary?: string;
}

export type RunTask = (input: TaskInput) => Promise<TaskOutcome>;

export interface RunDeps {
  runTask: RunTask;
  cluster: ClusterLease;
  store: {
    saveRun(run: JobRun): void;
    saveTaskRun(job: string, run: string, task: TaskRun): void;
    /** a line of the job's log */
    log(text: string): void;
    taskLog(job: string, run: string, task: string, attempt: number, text: string): void;
  };
  /** Never throws. */
  notify(spec: JobSpec, run: JobRun, event: NotifyEvent): Promise<unknown>;
  /** Wait (ends early when the signal aborts). */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Call `fn` after `ms`; returns what cancels it. */
  timer(ms: number, fn: () => void): () => void;
  now(): number;
}

export interface RunOptions {
  /** run-time params: they win over the job's and the tasks' */
  params?: Params;
  /** aborting it cancels the run (its reason says why) */
  signal?: AbortSignal;
  concurrency?: number;
}

/** The wait after attempt `failedAttempt` of a task failed. */
export function backoffMs(task: Pick<TaskSpec, "retryBackoffSeconds">, failedAttempt: number): number {
  return Math.min(task.retryBackoffSeconds * 2 ** (failedAttempt - 1), MAX_BACKOFF_SECONDS) * 1000;
}

export function mergeParams(spec: Pick<JobSpec, "params">, task: Pick<TaskSpec, "params">, overrides: Params = {}): Params {
  return { ...spec.params, ...task.params, ...overrides };
}

function reasonOf(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  return typeof r === "string" ? r : r instanceof Error ? r.message : "cancelled";
}

/** Run a job's tasks; resolves with the finished run (never rejects). */
export async function executeRun(spec: JobSpec, run: JobRun, deps: RunDeps, options: RunOptions = {}): Promise<JobRun> {
  const single = spec.tasks.length === 1;
  let current = run;
  let tasks: TaskRun[] = spec.tasks.map((t) => ({ key: t.key, status: "pending", attempt: 1 }));
  const notifications: Promise<unknown>[] = [];

  const stamp = () => new Date(deps.now()).toISOString().slice(11, 19);
  const log = (text: string) => deps.store.log(`[${stamp()}] ${text}\n`);
  const update = (patch: Partial<JobRun>) => {
    current = { ...current, ...patch, tasks };
    deps.store.saveRun(current);
  };
  const states = (): Record<string, TaskRunStatus> => Object.fromEntries(tasks.map((t) => [t.key, t.status]));
  /** replace fields of a task (a field set to undefined is dropped) */
  const setTask = (key: string, patch: Partial<TaskRun>) => {
    const next = { ...tasks.find((t) => t.key === key)!, ...patch };
    for (const k of Object.keys(next) as (keyof TaskRun)[]) if (next[k] === undefined) delete next[k];
    tasks = tasks.map((t) => (t.key === key ? next : t));
    current = { ...current, tasks };
    deps.store.saveTaskRun(current.job, current.id, next);
  };

  const ctl = new AbortController();
  const external = options.signal;
  const onExternal = () => ctl.abort(reasonOf(external!));
  if (external?.aborted) onExternal();
  else external?.addEventListener("abort", onExternal, { once: true });
  const cancelTimer = deps.timer(spec.timeoutMinutes * 60_000, () => ctl.abort(`timed out after ${spec.timeoutMinutes} min`));
  const signal = ctl.signal;

  const finish = async (status: RunStatus, error?: string, summary?: string) => {
    log(`${status}: ${error ?? summary ?? ""}`.trimEnd());
    update({ status, error, summary, endedAt: deps.now() });
    notifications.push(deps.notify(spec, current, status === "succeeded" ? "success" : "failure"));
    await Promise.all(notifications);
    return current;
  };

  let cluster: ClusterRef = { id: "", name: "" };

  /** Run one task through its attempts. */
  const runOne = async (task: TaskSpec): Promise<void> => {
    const params = mergeParams(spec, task, options.params);
    for (let attempt = 1; ; attempt++) {
      setTask(task.key, { status: "running", attempt, startedAt: deps.now(), endedAt: undefined, summary: undefined });
      log(`task ${task.key} started (attempt ${attempt})`);
      let outcome: TaskOutcome;
      try {
        outcome = await deps.runTask({
          jobId: spec.id,
          runId: current.id,
          task,
          attempt,
          params,
          cluster,
          signal,
          log: (text) => {
            deps.store.taskLog(spec.id, current.id, task.key, attempt, `[${stamp()}] ${text}\n`);
            if (single) log(text);
          },
        });
      } catch (e) {
        outcome = { status: "failed", error: (e as Error).message };
      }
      if (outcome.status === "succeeded") {
        setTask(task.key, { status: "succeeded", endedAt: deps.now(), summary: outcome.summary, error: undefined });
        log(`task ${task.key} succeeded${outcome.summary ? `: ${outcome.summary}` : ""}`);
        return;
      }
      if (outcome.status === "cancelled" || signal.aborted) {
        setTask(task.key, { status: "cancelled", endedAt: deps.now(), error: outcome.error ?? reasonOf(signal) });
        log(`task ${task.key} cancelled`);
        return;
      }
      const error = outcome.error ?? "failed";
      if (attempt > task.maxRetries) {
        setTask(task.key, { status: "failed", endedAt: deps.now(), error });
        log(`task ${task.key} failed: ${error}`);
        return;
      }
      const wait = backoffMs(task, attempt);
      setTask(task.key, { status: "starting", attempt: attempt + 1, error });
      log(`task ${task.key} failed: ${error}; attempt ${attempt + 1} in ${Math.round(wait / 1000)} s`);
      if (wait > 0) await deps.sleep(wait, signal);
      if (signal.aborted) {
        setTask(task.key, { status: "cancelled", endedAt: deps.now(), error: reasonOf(signal) });
        log(`task ${task.key} cancelled`);
        return;
      }
    }
  };

  /** The pending tasks, ended without running. */
  const endPending = (status: TaskRunStatus, error: string) => {
    for (const t of tasks.filter((x) => x.status === "pending")) {
      setTask(t.key, { status, endedAt: deps.now(), error });
      log(`task ${t.key} ${status}`);
    }
  };

  /** Mark the tasks that cannot run now (repeats: a skip can free the next ones). */
  const settleSkips = () => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of spec.tasks) {
        const status = skipStatus(t, states());
        if (!status) continue;
        setTask(t.key, { status, endedAt: deps.now() });
        log(`task ${t.key} ${status === "skipped" ? "skipped (run_if not met)" : "not run: upstream failed"}`);
        changed = true;
      }
    }
  };

  try {
    log(`run ${current.id} of ${single ? spec.tasks[0].target : `${spec.tasks.length} tasks`} (${current.trigger})`);
    const errors = validateDag(spec.tasks);
    if (errors.length) {
      for (const e of errors) log(`invalid job: ${e}`);
      endPending("skipped", "the job is not valid");
      return await finish("failed", `the job is not valid: ${errors.join("; ")}`);
    }
    update({ status: "starting" });
    notifications.push(deps.notify(spec, current, "start"));
    try {
      cluster = await deps.cluster.acquire(signal);
    } catch (e) {
      const why = signal.aborted ? reasonOf(signal) : (e as Error).message;
      endPending(signal.aborted ? "cancelled" : "skipped", why);
      return await finish(signal.aborted ? "cancelled" : "failed", why);
    }
    update({ status: "running", cluster: cluster.name });

    const running = new Map<string, Promise<void>>();
    const limit = options.concurrency ?? MAX_PARALLEL;
    for (;;) {
      if (signal.aborted) endPending("cancelled", reasonOf(signal));
      else {
        settleSkips();
        for (const key of readyTasks(spec.tasks, states())) {
          if (running.size >= limit) break;
          const task = spec.tasks.find((t) => t.key === key)!;
          setTask(key, { status: "running" }); // taken: not ready again
          running.set(key, runOne(task).finally(() => running.delete(key)));
        }
      }
      if (!running.size) break;
      await Promise.race(running.values());
    }
    endPending("skipped", "no way to run it");

    const failed = tasks.filter((t) => t.status === "failed");
    const ok = tasks.filter((t) => t.status === "succeeded").length;
    if (failed.length || tasks.some((t) => t.status === "upstream_failed")) {
      const error = single ? failed[0]?.error : `${failed.length} task(s) failed: ${failed.map((t) => t.key).join(", ")}${failed[0]?.error ? ` (${failed[0].error})` : ""}`;
      return await finish("failed", error ?? "a task failed");
    }
    if (tasks.some((t) => t.status === "cancelled")) return await finish("cancelled", signal.aborted ? reasonOf(signal) : "a task was cancelled");
    const summary = single ? tasks[0].summary : `${ok} of ${tasks.length} tasks succeeded${ok < tasks.length ? ` (${tasks.length - ok} skipped)` : ""}`;
    return await finish("succeeded", undefined, summary);
  } catch (e) {
    return await finish("failed", (e as Error).message);
  } finally {
    cancelTimer();
    external?.removeEventListener("abort", onExternal);
    await deps.cluster.release().catch((e: Error) => log(`cluster not terminated: ${e.message}`));
  }
}
