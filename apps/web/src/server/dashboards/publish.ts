import "server-only";

import fs from "node:fs";
import path from "node:path";

import type { ParamSpecs } from "@/features/queries/queryHeader";
import { detectParams, mergeSpecs } from "@/features/queries/queryParams";
import { ID } from "@/lib/dashboards/config";
import { datasetStatement } from "@/lib/dashboards/query";
import type { Dashboard, PublishedDashboard, Share, ViewDashboard } from "@/lib/dashboards/types";

import type { StudioUser } from "../auth/access";
import { dataDir } from "../compute/store";

/**
 * Published dashboards: a compiled copy of each in the Studio's data folder
 * (not the workspace's), one JSON file per dashboard id. Viewers only ever
 * read these, never the drafts.
 */

export function publishedDir(): string {
  return path.join(dataDir(), "dashboards");
}

function fileOf(dir: string, id: string): string {
  if (!ID.test(id)) throw new Error(`invalid dashboard id ${id}`);
  return path.join(dir, `${id}.json`);
}

/** The share with its emails normalized (throws when it is not one). */
function checkedShare(share: Share): Share {
  if (share.kind === "team") return { kind: "team" };
  if (share.kind !== "emails" || !Array.isArray(share.emails)) throw new Error("share is the team or a list of emails");
  const emails = [...new Set(share.emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  const bad = emails.find((e) => !/^[^\s@]+@[^\s@]+$/.test(e));
  if (bad) throw new Error(`${bad} is not an email`);
  return { kind: "emails", emails };
}

/** Why a dashboard cannot be published yet (empty: it can). */
function problemsOf(d: Dashboard): string[] {
  const out = d.problems.map((p) => `${p.file}: ${p.error}`);
  const datasets = new Set(d.datasets.map((x) => x.name));
  for (const x of d.datasets) {
    try {
      datasetStatement(x.sql);
    } catch (e) {
      out.push(`dataset ${x.name}: ${(e as Error).message}`);
    }
  }
  const placeholders = new Set(d.datasets.flatMap((x) => detectParams(x.sql)));
  for (const w of d.widgets) {
    if ((w.kind === "chart" || w.kind === "table") && !datasets.has(w.dataset)) out.push(`widget ${w.id}: there is no dataset ${w.dataset}`);
    if (w.kind !== "filter") continue;
    for (const f of w.fields ?? []) if (!datasets.has(f.dataset)) out.push(`filter ${w.id}: there is no dataset ${f.dataset}`);
    if (w.param && !placeholders.has(w.param)) out.push(`filter ${w.id}: no dataset has the placeholder :${w.param}`);
  }
  const widgets = new Set(d.widgets.map((w) => w.id));
  for (const i of d.layout) if (!widgets.has(i.widget)) out.push(`the layout places ${i.widget}, which is not a widget`);
  return out;
}

/** Publish (or republish) a dashboard: the compiled copy replaces the last one. Throws with what is wrong. */
export function publishDashboard(d: Dashboard, share: Share, by: string, dir = publishedDir()): PublishedDashboard {
  const problems = problemsOf(d);
  if (problems.length) throw new Error(`cannot publish: ${problems.join("; ")}`);
  const { id, title, description, cluster, refresh_minutes } = d.config;
  const published: PublishedDashboard = {
    id,
    slug: d.slug,
    title,
    ...(description && { description }),
    ...(cluster && { cluster }),
    refresh_minutes,
    datasets: d.datasets,
    widgets: d.widgets,
    layout: d.layout,
    share: checkedShare(share),
    publishedBy: by,
    publishedAt: Date.now(),
  };
  const file = fileOf(dir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(published));
  fs.renameSync(`${file}.tmp`, file);
  return published;
}

/** The published dashboard under `id` (null: none, or not an id). */
export function getPublished(id: string, dir = publishedDir()): PublishedDashboard | null {
  if (!ID.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(fileOf(dir, id), "utf8")) as PublishedDashboard;
  } catch {
    return null;
  }
}

/** Every published dashboard (unreadable files are skipped). */
export function listPublished(dir = publishedDir()): PublishedDashboard[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => (name.endsWith(".json") ? (getPublished(name.slice(0, -".json".length), dir) ?? []) : []));
}

export function unpublish(id: string, dir = publishedDir()): void {
  fs.rmSync(fileOf(dir, id), { force: true });
}

/** When a dashboard was published (null: it is not). */
export function publishedAt(id: string, dir = publishedDir()): number | null {
  return getPublished(id, dir)?.publishedAt ?? null;
}

/** Editors open every published dashboard; viewers the ones shared with the team or with their email. */
export function canView(p: PublishedDashboard, user: StudioUser): boolean {
  return !user.viewer || p.share.kind === "team" || p.share.emails.includes(user.email.trim().toLowerCase());
}

/** What a viewer's browser receives: no datasets, so no SQL. */
export function viewOf(p: PublishedDashboard): ViewDashboard {
  const params: ParamSpecs = {};
  const specs = p.datasets.map((d) => mergeSpecs(detectParams(d.sql), d.params));
  for (const w of p.widgets) {
    if (w.kind !== "filter" || !w.param) continue;
    const spec = specs.find((s) => Object.hasOwn(s, w.param!))?.[w.param];
    if (spec) params[w.param] = spec;
  }
  return { id: p.id, title: p.title, description: p.description, widgets: p.widgets, layout: p.layout, params, publishedAt: p.publishedAt };
}
