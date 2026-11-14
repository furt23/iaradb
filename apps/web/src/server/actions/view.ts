"use server";

import { checkPicks } from "@/lib/dashboards/query";
import type { CrossPicks, FilterValues, PublishedDashboard, RenderResult, ViewDashboard } from "@/lib/dashboards/types";

import type { StudioUser } from "../auth/access";
import { requireViewer } from "../auth/session";
import { cacheKey, cached } from "../dashboards/cache";
import { servedExtracts } from "../dashboards/extractRefresh";
import { canView, getPublished, listPublished, viewOf } from "../dashboards/publish";
import { renderDashboard } from "../dashboards/run";
import { isInitialView, readSnapshot } from "../dashboards/snapshots";
import { userAllow } from "../governance/store";
import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";

/**
 * What viewers (and editors, in the shared view) can do: open published
 * dashboards and read their data. Nothing here takes or returns SQL.
 */

export interface SharedSummary {
  id: string;
  title: string;
  description?: string;
  publishedAt: number;
}

/** The published dashboard, if the user may open it. A dashboard they may not open looks like one that is not there. */
function openable(id: string, user: StudioUser): PublishedDashboard {
  const p = getPublished(id);
  if (!p || !canView(p, user)) throw Object.assign(new Error("there is no such dashboard"), { type: "NotFound" });
  return p;
}

/** The published dashboards the user may open. */
export async function listShared(): Promise<ActionResult<SharedSummary[]>> {
  return attempt(async () => {
    const user = await requireViewer();
    return listPublished()
      .filter((p) => canView(p, user))
      .map(({ id, title, description, publishedAt }) => ({ id, title, ...(description && { description }), publishedAt }))
      .sort((a, b) => a.title.localeCompare(b.title));
  });
}

export async function openShared(id: string): Promise<ActionResult<ViewDashboard>> {
  return attempt(async () => {
    const user = await requireViewer();
    return viewOf(openable(id, user));
  });
}

/**
 * The data of a published dashboard for the viewer's filter values and chart picks; the same render is shared until the dashboard's refresh time passes.
 * The initial view (no values, no picks) is the render a scheduled job stored, if there is one.
 */
export async function renderShared(id: string, values: FilterValues, cross: CrossPicks): Promise<ActionResult<RenderResult>> {
  return attempt(async () => {
    const user = await requireViewer();
    const p = openable(id, user);
    const allow = userAllow(user);
    // before the key, so a browser cannot fill the cache with picks that are refused anyway
    checkPicks(p.widgets, cross);
    if (isInitialView(values, cross)) {
      const stored = readSnapshot(p, allow);
      if (stored) return stored;
    }
    // the key leaves out the extracts: a refresh that swaps them forgets the renders
    return cached(cacheKey(p.id, p, values, allow, cross), p.refresh_minutes * 60_000, async () =>
      renderDashboard(
        p,
        values,
        {
          request: async (method, params) => kernels.forDashboard(p.id, p.cluster).request(method, params, undefined, user.email || null),
          redact: true,
          source: `dashboard view ${p.title}`,
          allow,
          extracts: await servedExtracts(p.id, user.email || null),
        },
        cross,
      ),
    );
  });
}
