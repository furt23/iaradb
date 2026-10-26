import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ID } from "@/lib/dashboards/config";
import type { CrossPicks, FilterValues, PublishedDashboard, RenderResult, WidgetData } from "@/lib/dashboards/types";

import { authMode, emailList, studioUser } from "../auth/access";
import { dataDir } from "../compute/store";
import { allowFor, type Grant } from "../governance/grants";
import { cacheKey } from "./cache";
import { canView } from "./publish";
import { HIDDEN_ERROR } from "./run";

/**
 * Stored renders of published dashboards, written by a job that targets the
 * dashboard (`dashboards/<slug>`) and served to viewers who open its initial
 * view (no filter values, no chart picks) without waiting for a cluster. One
 * JSON file per dashboard and read-grant set (`allow`), named after the hash
 * of the render's cache key: a republish or a change of grants misses, and the
 * stale file is never read.
 */

export function snapshotsDir(): string {
  return path.join(dataDir(), "dashboards", "snapshots");
}

function checkedId(id: string): string {
  if (!ID.test(id)) throw new Error(`invalid dashboard id ${id}`);
  return id;
}

function fileOf(dir: string, p: PublishedDashboard, allow: string[] | null): string {
  const hash = crypto.createHash("sha1").update(cacheKey(checkedId(p.id), p, {}, allow, [])).digest("hex");
  return path.join(dir, `${p.id}.${hash}.json`);
}

/** Whether a view is the initial one: no filter values and no chart picks. What a browser sends in another shape is not, so the live render refuses it as before. */
export function isInitialView(values: FilterValues, cross: CrossPicks): boolean {
  return typeof values === "object" && values !== null && !Array.isArray(values) && Object.keys(values).length === 0 && Array.isArray(cross) && cross.length === 0;
}

/**
 * The distinct read grants (`allow`, null: everything) of the users who can
 * open the dashboard: each editor of `IARA_ALLOWED_EMAILS` (admins read
 * everything) and each viewer of `IARA_VIEWER_EMAILS` it is shared with (the
 * team, or by email). With sign-in off the only user reads everything.
 */
export function audienceAllows(p: PublishedDashboard, grants: Grant[], env: Record<string, string | undefined> = process.env): (string[] | null)[] {
  if (authMode(env) === "off") return [null];
  const allows = new Map<string, string[] | null>();
  for (const email of new Set([...emailList(env.IARA_ALLOWED_EMAILS), ...emailList(env.IARA_VIEWER_EMAILS)])) {
    const user = studioUser({ email, email_verified: true }, env);
    if (!user || !canView(p, user)) continue;
    const allow = allowFor(user, grants);
    allows.set(JSON.stringify(allow), allow);
  }
  return [...allows.values()];
}

/** The widgets as a viewer reads them: an error says nothing about the data or the queries. */
function hidden(result: RenderResult): RenderResult {
  const widgets: Record<string, WidgetData> = {};
  for (const [id, w] of Object.entries(result.widgets)) widgets[id] = w.kind === "error" ? { kind: "error", message: HIDDEN_ERROR } : w;
  return { ...result, widgets };
}

/** Keep a render of the initial view for the viewers whose grants are `allow` (written to a temp file and renamed, so a reader never sees half a file). */
export function saveSnapshot(p: PublishedDashboard, allow: string[] | null, result: RenderResult, dir = snapshotsDir()): void {
  const file = fileOf(dir, p, allow);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(hidden(result)));
  fs.renameSync(`${file}.tmp`, file);
}

/** The stored render of the dashboard's current content for these grants (null: none). */
export function readSnapshot(p: PublishedDashboard, allow: string[] | null, dir = snapshotsDir()): RenderResult | null {
  try {
    return JSON.parse(fs.readFileSync(fileOf(dir, p, allow), "utf8")) as RenderResult;
  } catch {
    return null;
  }
}

/** Remove every stored render of a dashboard. */
export function forgetSnapshots(id: string, dir = snapshotsDir()): void {
  const prefix = `${checkedId(id)}.`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) if (name.startsWith(prefix)) fs.rmSync(path.join(dir, name), { force: true });
}
