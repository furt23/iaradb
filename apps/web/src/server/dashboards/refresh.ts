import "server-only";

import type { DashboardConfig } from "@/lib/dashboards/types";
import { DEFAULT_TIMEOUT_MINUTES, JOB_CLUSTER, taskOf, type JobSpec } from "@/lib/jobs";

import { awsSettings } from "../compute/awsSettings";
import { REFRESH_INSTANCE_TYPE } from "../compute/instanceTypes";
import { LOCAL_CLUSTER } from "../compute/types";
import { getPublished } from "./publish";
import { DASHBOARDS_DIR, listConfigs } from "./store";

/**
 * A dashboard's scheduled refresh (the `[schedule]` of its dashboard.toml) as
 * a job of one task, run by the Jobs scheduler and runner like any job and
 * never listed in Jobs. Its runs are a job's runs, under `dashboard-<id>` (a
 * name job files cannot take). The task renders the published dashboard for
 * its viewers (taskRunner.ts).
 */

const TARGET = /^dashboards\/([a-z0-9][a-z0-9_-]{0,63})$/;

/** The slug of the dashboard a refresh task renders (null: the task runs a file). */
export function dashboardSlug(target: string): string | null {
  return TARGET.exec(target)?.[1] ?? null;
}

export function refreshJobId(dashboardId: string): string {
  return `dashboard-${dashboardId}`;
}

/** The refresh of `dashboards/<slug>`: a new small cluster per run with AWS, else the dashboard's cluster (Local, in development). */
export function refreshJob(slug: string, config: DashboardConfig, cloud = awsSettings() !== null): JobSpec {
  return {
    id: refreshJobId(config.id),
    name: `Refresh ${config.title}`,
    tasks: [taskOf(`${DASHBOARDS_DIR}/${slug}`)],
    params: {},
    notify: [],
    schedule: config.schedule?.cron ?? null,
    cluster: cloud ? JOB_CLUSTER : (config.cluster ?? LOCAL_CLUSTER),
    instanceType: cloud ? REFRESH_INSTANCE_TYPE : null,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    enabled: config.schedule?.enabled ?? false,
  };
}

/** What the scheduler looks at: the refreshes of published dashboards that have a schedule. */
export async function refreshJobs(): Promise<JobSpec[]> {
  const cloud = awsSettings() !== null;
  return (await listConfigs()).filter(({ config }) => config.schedule && getPublished(config.id)).map(({ slug, config }) => refreshJob(slug, config, cloud));
}
