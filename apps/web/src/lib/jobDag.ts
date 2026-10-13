/**
 * The task graph of a job (pure): checks it, orders it, and says which tasks
 * run next from how their upstream tasks ended. A task with no upstream
 * tasks always runs.
 */

import type { RunIf, TaskRunStatus, TaskSpec } from "./jobs";

const KEY = /^[A-Za-z0-9_-]+$/;

/** the statuses a task ends in (it has no more to do) */
const FINISHED: ReadonlySet<TaskRunStatus> = new Set(["succeeded", "failed", "cancelled", "skipped", "upstream_failed"]);
/** the upstream outcomes that count as failed for run_if (a cancelled task counts too) */
const FAILED: ReadonlySet<TaskRunStatus> = new Set(["failed", "upstream_failed", "cancelled"]);

export function isTaskFinished(status: TaskRunStatus): boolean {
  return FINISHED.has(status);
}

/** A task's state (one never seen is pending). */
function stateOf(states: Record<string, TaskRunStatus>, key: string): TaskRunStatus {
  return Object.hasOwn(states, key) ? states[key] : "pending";
}

function upstreamStates(task: TaskSpec, states: Record<string, TaskRunStatus>): TaskRunStatus[] {
  return task.dependsOn.map((k) => stateOf(states, k));
}

/**
 * Kahn's algorithm: repeatedly take the tasks whose upstream tasks are all
 * placed (in declaration order). Returns the order, and the tasks left over
 * (in a cycle, or after one). Unknown and self upstreams are left out here.
 */
function sortTasks(tasks: TaskSpec[]): { order: string[]; left: TaskSpec[] } {
  const known = new Set(tasks.map((t) => t.key));
  const placed = new Set<string>();
  const order: string[] = [];
  let left = tasks;
  for (;;) {
    const ready = left.filter((t) => t.dependsOn.every((k) => k === t.key || !known.has(k) || placed.has(k)));
    if (!ready.length) return { order, left };
    for (const t of ready) {
      if (placed.has(t.key)) continue;
      placed.add(t.key);
      order.push(t.key);
    }
    left = left.filter((t) => !placed.has(t.key));
  }
}

/** One dependency cycle among the tasks left over: a -> b -> a (an arrow reads "depends on"). */
function cycleOf(left: TaskSpec[]): string[] {
  const byKey = new Map(left.map((t) => [t.key, t]));
  const path: string[] = [];
  let cur = left[0].key;
  while (!path.includes(cur)) {
    path.push(cur);
    cur = byKey.get(cur)?.dependsOn.find((k) => byKey.has(k) && k !== cur) ?? cur;
  }
  return [...path.slice(path.indexOf(cur)), cur];
}

/** What is wrong with a job's tasks (empty when it is a valid DAG). */
export function validateDag(tasks: TaskSpec[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const t of tasks) {
    if (!t.key) errors.push("a task has an empty key");
    else if (!KEY.test(t.key)) errors.push(`task key "${t.key}" has characters other than letters, digits, _ and -`);
    else if (seen.has(t.key)) errors.push(`task key "${t.key}" is used twice`);
    seen.add(t.key);
  }
  const known = new Set(tasks.map((t) => t.key));
  for (const t of tasks) {
    const listed = new Set<string>();
    for (const up of t.dependsOn) {
      if (up === t.key) errors.push(`task "${t.key}" depends on itself`);
      else if (!known.has(up)) errors.push(`task "${t.key}" depends on "${up}", which is not a task`);
      else if (listed.has(up)) errors.push(`task "${t.key}" lists "${up}" twice`);
      listed.add(up);
    }
  }
  const { left } = sortTasks(tasks);
  if (left.length) errors.push(`dependency cycle: ${cycleOf(left).join(" -> ")}`);
  return errors;
}

/** The keys in an order where every task comes after its upstream tasks (tasks in a cycle are left out). */
export function topoOrder(tasks: TaskSpec[]): string[] {
  return sortTasks(tasks).order;
}

/**
 * Whether a task's run_if holds for its upstream statuses. Databricks
 * semantics: all_success (all succeeded), all_done (all finished),
 * at_least_one_success, none_failed (skipped is fine), all_failed.
 */
export function runIfSatisfied(runIf: RunIf, upstreams: TaskRunStatus[]): boolean {
  if (!upstreams.length) return true;
  switch (runIf) {
    case "all_success":
      return upstreams.every((s) => s === "succeeded");
    case "all_done":
      return upstreams.every(isTaskFinished);
    case "at_least_one_success":
      return upstreams.some((s) => s === "succeeded");
    case "none_failed":
      return !upstreams.some((s) => FAILED.has(s));
    case "all_failed":
      return upstreams.every((s) => FAILED.has(s));
  }
}

/** The pending tasks that can start now: every upstream finished and run_if holds. */
export function readyTasks(tasks: TaskSpec[], states: Record<string, TaskRunStatus>): string[] {
  return tasks
    .filter((t) => stateOf(states, t.key) === "pending")
    .filter((t) => {
      const ups = upstreamStates(t, states);
      return ups.every(isTaskFinished) && runIfSatisfied(t.runIf, ups);
    })
    .map((t) => t.key);
}

/**
 * The status a pending task gets when it cannot run: its upstream tasks are
 * all finished but its run_if does not hold. "upstream_failed" when an
 * upstream failed, else "skipped". Null while it can still run or wait.
 */
export function skipStatus(task: TaskSpec, states: Record<string, TaskRunStatus>): TaskRunStatus | null {
  if (stateOf(states, task.key) !== "pending") return null;
  const ups = upstreamStates(task, states);
  if (!ups.every(isTaskFinished) || runIfSatisfied(task.runIf, ups)) return null;
  return ups.some((s) => FAILED.has(s)) ? "upstream_failed" : "skipped";
}
