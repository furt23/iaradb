/**
 * Jobs: a notebook or a `.sql` file run without anyone watching, by hand or
 * on a schedule (pure). A job is a TOML file of the workspace, versioned
 * with it:
 *
 *     # jobs/nightly_sales.toml
 *     name = "Nightly sales"
 *     target = "notebooks/sales.py"
 *     schedule = "0 6 * * *"          # cron, UTC; omitted: by hand only
 *     cluster = "job"                 # a new cluster per run, or a cluster's name
 *     instance_type = "m7i-flex.large"
 *     timeout_minutes = 60
 */

import { parse, stringify } from "smol-toml";

import { lastRun, nextRun, parseCron } from "./cron";

export interface JobSpec {
  /** the file's name: `jobs/<id>.toml` */
  id: string;
  name: string;
  /** a notebook (`.py`) or a query file (`.sql`) of the workspace */
  target: string;
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

/** Check a job (throws with what is wrong). */
export function checkJob(spec: JobSpec): JobSpec {
  if (!/\.(py|sql)$/i.test(spec.target)) throw new Error("the target is a notebook (.py) or a query file (.sql)");
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
  return checkJob({
    id,
    name: typeof cfg.name === "string" && cfg.name.trim() ? cfg.name.trim() : id,
    target: text(cfg.target, "target"),
    schedule: typeof cfg.schedule === "string" && cfg.schedule.trim() ? cfg.schedule.trim() : null,
    cluster: typeof cfg.cluster === "string" && cfg.cluster.trim() ? cfg.cluster.trim() : JOB_CLUSTER,
    instanceType: typeof cfg.instance_type === "string" && cfg.instance_type ? cfg.instance_type : null,
    timeoutMinutes: typeof cfg.timeout_minutes === "number" ? cfg.timeout_minutes : DEFAULT_TIMEOUT_MINUTES,
    enabled: cfg.enabled !== false,
  });
}

/** The file of a job. */
export function jobToml(spec: JobSpec): string {
  const cfg: Record<string, unknown> = { name: spec.name, target: spec.target };
  if (spec.schedule) cfg.schedule = spec.schedule;
  cfg.cluster = spec.cluster;
  if (spec.cluster === JOB_CLUSTER && spec.instanceType) cfg.instance_type = spec.instanceType;
  cfg.timeout_minutes = spec.timeoutMinutes;
  if (!spec.enabled) cfg.enabled = false;
  return `# A Workhouse job: runs ${spec.target}${spec.schedule ? " on a schedule (cron, UTC)" : " by hand"}.\n${stringify(cfg)}\n`;
}
