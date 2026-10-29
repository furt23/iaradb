"use server";

import { freshEntry, type ExtractManifest } from "@/lib/dashboards/extracts";
import type { Dataset } from "@/lib/dashboards/types";

import { requireUser } from "../auth/session";
import { datasetHash, readManifest } from "../dashboards/extractStore";
import { readDashboard, saveDatasetMode } from "../dashboards/store";
import { attempt, type ActionResult } from "../result";

export interface DatasetExtractStatus {
  /** "params": live because it has parameters of its own */
  mode: "extract" | "live" | "params";
  /** the imported copy built from the dataset as it is now (null: none yet, or stale) */
  fresh: { rows: number; bytes: number; refreshed_at: number } | null;
  /** a copy exists, but from an older version of the dataset (it is rebuilt on publish) */
  stale: boolean;
}

function statusOf(d: Dataset, manifest: ExtractManifest | null): DatasetExtractStatus {
  const fresh = freshEntry(manifest, d.name, datasetHash(d));
  return {
    mode: d.mode === "live" ? "live" : Object.keys(d.params).length ? "params" : "extract",
    fresh: fresh && { rows: fresh.rows, bytes: fresh.bytes, refreshed_at: fresh.refreshed_at },
    stale: !fresh && manifest !== null && Object.hasOwn(manifest.datasets, d.name),
  };
}

/** How each dataset of the dashboard reaches viewers, by dataset name. */
export async function extractStatus(slug: string): Promise<ActionResult<Record<string, DatasetExtractStatus>>> {
  return attempt(async () => {
    await requireUser();
    const { config, datasets } = await readDashboard(slug);
    const manifest = await readManifest(config.id);
    const statuses: Record<string, DatasetExtractStatus> = {};
    for (const d of datasets) statuses[d.name] = statusOf(d, manifest);
    return statuses;
  });
}

/** Imported (viewers read a stored copy) or live (every view runs the query). */
export async function setDatasetMode(slug: string, name: string, mode: "extract" | "live"): Promise<ActionResult<Dataset>> {
  return attempt(async () => {
    await requireUser();
    return saveDatasetMode(slug, name, mode);
  });
}
