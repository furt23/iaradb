"use server";

import type { ColumnInfo } from "@iara/protocol";

import { datasetQuery } from "@/lib/dashboards/query";
import type { CrossPicks, Dashboard, DashboardConfig, DashboardSummary, Dataset, FilterValues, LayoutItem, Recipe, RenderResult, Share, Widget } from "@/lib/dashboards/types";
import { nextScheduled, type JobRun } from "@/lib/jobs";

import { requireUser } from "../auth/session";
import { forget } from "../dashboards/cache";
import { getPublished, publishDashboard, unpublish } from "../dashboards/publish";
import { refreshJob, refreshJobId } from "../dashboards/refresh";
import { allowParam, explainDatasets, renderDashboard, withSql, type RunDeps } from "../dashboards/run";
import { forgetSnapshots } from "../dashboards/snapshots";
import {
  createDashboard,
  deleteDashboard,
  deleteDataset,
  deleteWidget,
  listDashboards,
  readConfig,
  readDashboard,
  saveConfig,
  saveDataset,
  saveLayout,
  saveRecipe,
  saveWidget,
  type DashboardProblem,
} from "../dashboards/store";
import { userAllow } from "../governance/store";
import { activeRun, startRun } from "../jobs/runner";
import { forgetJob, listRuns } from "../jobs/runs";
import { startScheduler } from "../jobs/scheduler";
import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";

/** Drop a dashboard's renders, in memory and on disk: a new publish must never show an older one. */
function forgetAll(id: string): void {
  forget(id);
  forgetSnapshots(id);
}

/** Where a dashboard is published and for whom (editors only; viewers never see this). */
export interface PublishedInfo {
  share: Share;
  publishedAt: number;
  publishedBy: string;
}

export interface OpenedDashboard {
  dashboard: Dashboard;
  published: PublishedInfo | null;
}

/** The dashboard's kernel, on its cluster. */
function requestOn(config: DashboardConfig): RunDeps["request"] {
  return async (method, params) => kernels.forDashboard(config.id, config.cluster).request(method, params);
}

export async function listDashboardsAction(): Promise<ActionResult<{ dashboards: DashboardSummary[]; problems: DashboardProblem[] }>> {
  return attempt(async () => {
    await requireUser();
    return listDashboards();
  });
}

export async function openDashboard(slug: string): Promise<ActionResult<OpenedDashboard>> {
  return attempt(async () => {
    await requireUser();
    const dashboard = await readDashboard(slug);
    const p = getPublished(dashboard.config.id);
    return { dashboard, published: p && { share: p.share, publishedAt: p.publishedAt, publishedBy: p.publishedBy } };
  });
}

export async function createDashboardAction(title: string): Promise<ActionResult<Dashboard>> {
  return attempt(async () => {
    await requireUser();
    return createDashboard(title);
  });
}

export async function saveConfigAction(slug: string, config: DashboardConfig): Promise<ActionResult<DashboardConfig>> {
  return attempt(async () => {
    await requireUser();
    return saveConfig(slug, config);
  });
}

/** `text`: the whole file of the dataset, with its `-- iara:params` header. */
export async function saveDatasetAction(slug: string, name: string, text: string): Promise<ActionResult<Dataset>> {
  return attempt(async () => {
    await requireUser();
    return saveDataset(slug, name, text);
  });
}

/** A dataset made of Data Wrangler steps over a catalog table; the kernel compiles it to SQL when it runs. */
export async function saveRecipeAction(slug: string, name: string, recipe: Recipe): Promise<ActionResult<Dataset>> {
  return attempt(async () => {
    await requireUser();
    return saveRecipe(slug, name, recipe);
  });
}

export async function deleteDatasetAction(slug: string, name: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    await deleteDataset(slug, name);
    return null;
  });
}

export async function saveWidgetAction(slug: string, widget: Widget): Promise<ActionResult<Widget>> {
  return attempt(async () => {
    await requireUser();
    return saveWidget(slug, widget);
  });
}

export async function deleteWidgetAction(slug: string, id: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    await deleteWidget(slug, id);
    return null;
  });
}

export async function saveLayoutAction(slug: string, items: LayoutItem[]): Promise<ActionResult<LayoutItem[]>> {
  return attempt(async () => {
    await requireUser();
    return saveLayout(slug, items);
  });
}

export async function deleteDashboardAction(slug: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    const id = await deleteDashboard(slug);
    if (id) {
      forgetAll(id);
      forgetJob(refreshJobId(id));
    }
    return null;
  });
}

/** Run the dashboard as it is on disk, with the editor's filter values and chart picks: errors show in full, nothing is cached. */
export async function runDraft(slug: string, values: FilterValues, cross: CrossPicks): Promise<ActionResult<RenderResult>> {
  return attempt(async () => {
    const user = await requireUser();
    const d = await readDashboard(slug);
    return renderDashboard(d, values, { request: requestOn(d.config), redact: false, source: `dashboard ${d.config.title}`, allow: userAllow(user) }, cross);
  });
}

/** The columns a dataset returns (its query runs with `LIMIT 0`): what the editor needs to configure widgets that have no data yet. */
export async function datasetColumns(slug: string, name: string): Promise<ActionResult<ColumnInfo[]>> {
  return attempt(async () => {
    const user = await requireUser();
    const { config, datasets } = await readDashboard(slug);
    const found = datasets.find((d) => d.name === name);
    if (!found) throw new Error(`there is no dataset ${name}`);
    const request = requestOn(config);
    const q = datasetQuery(await withSql(found, request), [], {}, {});
    if ("missing" in q) throw new Error(`needs a value for ${q.missing.map((n) => `:${n}`).join(", ")}`);
    const output = await request("sql.run", { query: `${q.query}\nLIMIT 0`, source: `dashboard ${config.title}`, ...q.params, ...allowParam(userAllow(user)) });
    if (output.type === "error") throw new Error(`${output.ename}: ${output.evalue}`);
    if (output.type !== "table") throw new Error("the dataset did not return a table");
    return output.result.columns;
  });
}

/** Publish the dashboard as it is on disk, to the team or to some emails. */
export async function publishAction(slug: string, share: Share): Promise<ActionResult<PublishedInfo>> {
  return attempt(async () => {
    const user = await requireUser();
    const d = await readDashboard(slug);
    // recipes are compiled here, so the published copy carries their SQL and viewers never wait on a compile
    const request = requestOn(d.config);
    const datasets: Dataset[] = [];
    for (const x of d.datasets) {
      try {
        datasets.push(await withSql(x, request));
      } catch (e) {
        throw new Error(`cannot publish: dataset ${x.name}: ${(e as Error).message}`);
      }
    }
    // viewers' grants are checked when they run; the publisher may only publish what they may read themselves
    const problems = await explainDatasets(datasets, { request, allow: userAllow(user) });
    if (problems.length) throw new Error(`cannot publish: ${problems.join("; ")}`);
    const p = publishDashboard({ ...d, datasets }, share, user.email);
    forgetAll(p.id);
    return { share: p.share, publishedAt: p.publishedAt, publishedBy: p.publishedBy };
  });
}

export async function unpublishAction(slug: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    const { id } = await readConfig(slug);
    unpublish(id);
    forgetAll(id);
    return null;
  });
}

const RECENT_REFRESHES = 10;

export interface RefreshStatus {
  /** newest first, the one going on included */
  runs: JobRun[];
  /** when the schedule refreshes it next (null: no schedule, disabled, or not published) */
  nextRun: number | null;
  published: boolean;
}

/** The dashboard's recent refreshes (scheduled or by hand) and when the next one is. */
export async function refreshStatus(slug: string): Promise<ActionResult<RefreshStatus>> {
  return attempt(async () => {
    await requireUser();
    startScheduler();
    const config = await readConfig(slug);
    const spec = refreshJob(slug, config);
    const live = activeRun(spec.id);
    const runs = listRuns(spec.id);
    const published = getPublished(config.id) !== null;
    return {
      runs: (live ? [live, ...runs.filter((r) => r.id !== live.id)] : runs).slice(0, RECENT_REFRESHES),
      nextRun: published ? nextScheduled(spec, new Date()) : null,
      published,
    };
  });
}

/** Refresh the published dashboard now, on the same cluster as its scheduled refreshes. */
export async function refreshNow(slug: string): Promise<ActionResult<JobRun>> {
  return attempt(async () => {
    await requireUser();
    const config = await readConfig(slug);
    if (!getPublished(config.id)) throw new Error("publish the dashboard first: a refresh renders the published copy");
    return startRun(refreshJob(slug, config), "manual");
  });
}
