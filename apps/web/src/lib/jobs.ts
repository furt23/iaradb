/**
 * Jobs: notebooks and query files run without anyone watching, by hand or
 * on a schedule (pure). A job is a TOML file of the workspace, versioned
 * with it:
 *
 *     # jobs/nightly_sales.toml
 *     name = "Nightly sales"
 *     schedule = "0 6 * * *"          # cron, UTC; omitted: by hand only
 *     cluster = "job"                 # a new cluster per run, or a cluster's name
 *     instance_type = "m7i-flex.large"
 *     timeout_minutes = 60
 *     target = "notebooks/sales.py"   # one task; or several [[task]] tables (below)
 *
 * Several tasks form a DAG (see jobDag.ts): each `[[task]]` names its
 * `depends_on` and when it runs (`run_if`). A file with only `target` is one
 * task keyed "main".
 */

import { parse, stringify } from "smol-toml";

import { lastRun, nextRun, parseCron } from "./cron";
import { validateDag } from "./jobDag";

export type ParamValue = string | number | boolean;
export type Params = Record<string, ParamValue>;

/** When a task runs, from how its upstream tasks ended (Databricks' run_if). */
export const RUN_IFS = ["all_success", "all_done", "at_least_one_success", "none_failed", "all_failed"] as const;
export type RunIf = (typeof RUN_IFS)[number];
export const RUN_IF_DEFAULT: RunIf = "all_success";

export interface TaskSpec {
  /** names the task in `dependsOn` and in its runs: letters, digits, `_` and `-` */
  key: string;
  /** a notebook (`.py`) or a query file (`.sql`) of the workspace */
  target: string;
  /** keys of the tasks that run before this one */
  dependsOn: string[];
  runIf: RunIf;
  maxRetries: number;
  retryBackoffSeconds: number;
  /** omitted: the job's timeout */
  timeoutMinutes?: number;
  params: Params;
}

export const MAIN_TASK = "main";

/** A task that runs `target` with the defaults. */
export function taskOf(target: string, key: string = MAIN_TASK): TaskSpec {
  return { key, target, dependsOn: [], runIf: RUN_IF_DEFAULT, maxRetries: 0, retryBackoffSeconds: 0, params: {} };
}

export const NOTIFY_EVENTS = ["start", "success", "failure"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** A webhook called on the job's events. */
export interface NotifySpec {
  on: NotifyEvent[];
  webhook: string;
}

export interface JobSpec {
  /** the file's name: `jobs/<id>.toml` */
  id: string;
  name: string;
  /** what runs, in the order the DAG allows (at least one task) */
  tasks: TaskSpec[];
  /** the job's `[params]` */
  params: Params;
  notify: NotifySpec[];
  /** cron, UTC (null: runs by hand only) */
  schedule: string | null;
  /** "job": a cluster made for each run and terminated after it; else a cluster's name */
  cluster: string;
  /** the machine of job clusters */
  instanceType: string | null;
  timeoutMinutes: number;
  enabled: boolean;
}

export const JOB_CLUSTER = "job";
export const DEFAULT_TIMEOUT_MINUTES = 60;

export type RunStatus = "starting" | "running" | "succeeded" | "failed" | "cancelled";
export type RunTrigger = "manual" | "schedule";

export type TaskRunStatus = "pending" | "skipped" | "upstream_failed" | "starting" | "running" | "succeeded" | "failed" | "cancelled";

/** One task of a run. */
export interface TaskRun {
  key: string;
  status: TaskRunStatus;
  /** 1 for the first try, more with retries */
  attempt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  summary?: string;
}

export interface JobRun {
  id: string;
  job: string;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  /** the cluster it ran on (by name) */
  cluster?: string;
  /** what it did: cells run, statements run */
  summary?: string;
  error?: string;
  /** per task (absent in runs written before tasks) */
  tasks?: TaskRun[];
}

export function isFinished(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/**
 * The scheduled time a job should run for, now, if any: its schedule fired
 * since `lastFired` (a job seen for the first time waits for its next time).
 */
export function due(spec: JobSpec, lastFired: number | undefined, now: Date): number | null {
  if (!spec.enabled || !spec.schedule || lastFired === undefined) return null;
  const last = lastRun(parseCron(spec.schedule), now, 24 * 3600_000)?.getTime() ?? null;
  return last !== null && last > lastFired ? last : null;
}

/** When a job runs next on its schedule (null: by hand only, or disabled). */
export function nextScheduled(spec: JobSpec, after: Date): number | null {
  if (!spec.enabled || !spec.schedule) return null;
  return nextRun(parseCron(spec.schedule), after)?.getTime() ?? null;
}

/** A file name for a job called `name`. */
export function jobId(name: string): string {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return id || "job";
}

function text(v: unknown, what: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} is missing`);
  return v.trim();
}

function optionalNumber(v: unknown, what: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number") throw new Error(`${what} is a number`);
  return v;
}

function strings(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${what} is a list of strings`);
  return v.map((x) => x.trim());
}

function isParamValue(v: unknown): v is ParamValue {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function paramsOf(v: unknown, what: string): Params {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} is a table`);
  const out: Params = {};
  for (const [k, x] of Object.entries(v)) {
    if (!isParamValue(x)) throw new Error(`${what}.${k} is a string, a number or a boolean`);
    out[k] = x;
  }
  return out;
}

/** The tables of a `[[name]]` list (none when absent). */
function tables(v: unknown, what: string): Record<string, unknown>[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((t) => !t || typeof t !== "object" || Array.isArray(t))) throw new Error(`${what} is a list of tables`);
  return v as Record<string, unknown>[];
}

function parseTask(cfg: Record<string, unknown>, i: number): TaskSpec {
  const key = typeof cfg.key === "string" ? cfg.key.trim() : "";
  const what = key ? `task ${key}` : `task ${i + 1}`;
  const runIf = cfg.run_if ?? RUN_IF_DEFAULT;
  if (!RUN_IFS.includes(runIf as RunIf)) throw new Error(`${what}: run_if is one of ${RUN_IFS.join(", ")}`);
  return {
    key,
    target: text(cfg.target, `${what} target`),
    dependsOn: strings(cfg.depends_on, `${what} depends_on`),
    runIf: runIf as RunIf,
    maxRetries: optionalNumber(cfg.max_retries, `${what} max_retries`) ?? 0,
    retryBackoffSeconds: optionalNumber(cfg.retry_backoff_seconds, `${what} retry_backoff_seconds`) ?? 0,
    timeoutMinutes: optionalNumber(cfg.timeout_minutes, `${what} timeout_minutes`),
    params: paramsOf(cfg.params, `${what} params`),
  };
}

function parseNotify(cfg: Record<string, unknown>, i: number): NotifySpec {
  return {
    on: strings(cfg.on, `notify ${i + 1} on`) as NotifyEvent[],
    webhook: text(cfg.webhook, `notify ${i + 1} webhook`),
  };
}

/** Check a job (throws with what is wrong). */
export function checkJob(spec: JobSpec): JobSpec {
  if (!spec.tasks.length) throw new Error("a job has at least one task");
  const dag = validateDag(spec.tasks);
  if (dag.length) throw new Error(dag.join("; "));
  for (const t of spec.tasks) {
    // a job of one task keeps the plain messages
    const where = spec.tasks.length > 1 ? `task ${t.key}: ` : "";
    if (!/\.(py|sql)$/i.test(t.target)) throw new Error(`${where}the target is a notebook (.py) or a query file (.sql)`);
    if (!Number.isInteger(t.maxRetries) || t.maxRetries < 0 || t.maxRetries > 10) throw new Error(`${where}max_retries is a whole number between 0 and 10`);
    if (!Number.isInteger(t.retryBackoffSeconds) || t.retryBackoffSeconds < 0 || t.retryBackoffSeconds > 3600) {
      throw new Error(`${where}retry_backoff_seconds is a whole number between 0 and 3600`);
    }
    if (t.timeoutMinutes !== undefined && (!Number.isFinite(t.timeoutMinutes) || t.timeoutMinutes < 1 || t.timeoutMinutes > 24 * 60)) {
      throw new Error(`${where}timeout_minutes is between 1 and 1440`);
    }
  }
  for (const n of spec.notify) {
    if (!n.on.length || n.on.some((e) => !NOTIFY_EVENTS.includes(e))) throw new Error(`notify on is a list of ${NOTIFY_EVENTS.join(", ")}`);
    if (!/^https?:\/\//.test(n.webhook)) throw new Error("notify webhook is an http or https URL");
  }
  if (spec.schedule) {
    try {
      parseCron(spec.schedule);
    } catch (e) {
      throw new Error(`schedule: ${(e as Error).message}`);
    }
  }
  if (!Number.isFinite(spec.timeoutMinutes) || spec.timeoutMinutes < 1 || spec.timeoutMinutes > 24 * 60) {
    throw new Error("timeout_minutes is between 1 and 1440");
  }
  return spec;
}

export function parseJob(id: string, toml: string): JobSpec {
  let cfg: Record<string, unknown>;
  try {
    cfg = parse(toml) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`not valid TOML: ${(e as Error).message}`);
  }
  // a file has either one `target` (one task) or `[[task]]` tables
  let tasks: TaskSpec[];
  if (cfg.task === undefined) {
    tasks = [taskOf(text(cfg.target, "target"))];
  } else {
    if (cfg.target !== undefined) throw new Error("a job has either a target or [[task]] tables, not both");
    tasks = tables(cfg.task, "task").map(parseTask);
  }
  return checkJob({
    id,
    name: typeof cfg.name === "string" && cfg.name.trim() ? cfg.name.trim() : id,
    tasks,
    params: paramsOf(cfg.params, "params"),
    notify: tables(cfg.notify, "notify").map(parseNotify),
    schedule: typeof cfg.schedule === "string" && cfg.schedule.trim() ? cfg.schedule.trim() : null,
    cluster: typeof cfg.cluster === "string" && cfg.cluster.trim() ? cfg.cluster.trim() : JOB_CLUSTER,
    instanceType: typeof cfg.instance_type === "string" && cfg.instance_type ? cfg.instance_type : null,
    timeoutMinutes: typeof cfg.timeout_minutes === "number" ? cfg.timeout_minutes : DEFAULT_TIMEOUT_MINUTES,
    enabled: cfg.enabled !== false,
  });
}

/** One task and nothing else on it: the file keeps the plain `target` form. */
function isPlain(spec: JobSpec): boolean {
  if (spec.tasks.length !== 1 || spec.notify.length || Object.keys(spec.params).length) return false;
  const t = spec.tasks[0];
  return (
    t.key === MAIN_TASK &&
    !t.dependsOn.length &&
    t.runIf === RUN_IF_DEFAULT &&
    !t.maxRetries &&
    !t.retryBackoffSeconds &&
    t.timeoutMinutes === undefined &&
    !Object.keys(t.params).length
  );
}

function taskTable(t: TaskSpec): Record<string, unknown> {
  const cfg: Record<string, unknown> = { key: t.key, target: t.target };
  if (t.dependsOn.length) cfg.depends_on = t.dependsOn;
  if (t.runIf !== RUN_IF_DEFAULT) cfg.run_if = t.runIf;
  if (t.maxRetries) cfg.max_retries = t.maxRetries;
  if (t.retryBackoffSeconds) cfg.retry_backoff_seconds = t.retryBackoffSeconds;
  if (t.timeoutMinutes !== undefined) cfg.timeout_minutes = t.timeoutMinutes;
  if (Object.keys(t.params).length) cfg.params = t.params;
  return cfg;
}

/** The file of a job. */
export function jobToml(spec: JobSpec): string {
  const plain = isPlain(spec);
  const cfg: Record<string, unknown> = { name: spec.name };
  if (plain) cfg.target = spec.tasks[0].target;
  if (spec.schedule) cfg.schedule = spec.schedule;
  cfg.cluster = spec.cluster;
  if (spec.cluster === JOB_CLUSTER && spec.instanceType) cfg.instance_type = spec.instanceType;
  cfg.timeout_minutes = spec.timeoutMinutes;
  if (!spec.enabled) cfg.enabled = false;
  if (Object.keys(spec.params).length) cfg.params = spec.params;
  if (!plain) cfg.task = spec.tasks.map(taskTable);
  if (spec.notify.length) cfg.notify = spec.notify.map((n) => ({ on: n.on, webhook: n.webhook }));
  // one task: the header names its target (so moving the target can retarget the file)
  const runs = spec.tasks.length === 1 ? spec.tasks[0].target : `${spec.tasks.length} tasks`;
  return `# A Iara job: runs ${runs}${spec.schedule ? " on a schedule (cron, UTC)" : " by hand"}.\n${stringify(cfg)}\n`;
}
