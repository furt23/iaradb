import "server-only";

import { type ExtractManifest, freshEntry, wantsExtract } from "@/lib/dashboards/extracts";
import type { PublishedDashboard } from "@/lib/dashboards/types";

import { kernels } from "../kernel/manager";
import { datasetHash, readManifest } from "./extractStore";

/**
 * Whether a scheduled refresh of a published dashboard would rebuild nothing new:
 * every dataset is served from an extract built from its current definition, from
 * the same versions of its base tables as those are now. Then the refresh is skipped
 * before a cluster starts (see jobs/scheduler.ts).
 */

export interface UnchangedDeps {
  manifest(id: string): Promise<ExtractManifest | null>;
  /** the table's Delta version as its log is now (null: unknown). Read from storage on each call, never from a table loaded earlier. */
  version(table: string): Promise<number | null>;
}

const realDeps: UnchangedDeps = {
  manifest: readManifest,
  version: async (table) => (await kernels.metadata("catalog.history", { table, limit: 1 }))[0]?.version ?? null,
};

export async function sourcesUnchanged(p: PublishedDashboard, deps: UnchangedDeps = realDeps): Promise<boolean> {
  try {
    if (p.datasets.length === 0) return false;
    const manifest = await deps.manifest(p.id);
    for (const d of p.datasets) {
      if (!wantsExtract(d)) return false;
      const versions = freshEntry(manifest, d.name, datasetHash(d))?.versions;
      if (!versions || Object.keys(versions).length === 0) return false;
      for (const [table, stored] of Object.entries(versions)) {
        if ((await deps.version(table)) !== stored) return false;
      }
    }
    return true;
  } catch {
    // a refresh that runs when it need not costs a cluster; one that is skipped when it must loses data
    return false;
  }
}
