import "server-only";

import crypto from "node:crypto";

import { type ExtractEntry, newVersion, wantsExtract } from "@/lib/dashboards/extracts";
import { datasetStatement } from "@/lib/dashboards/query";
import type { PublishedDashboard } from "@/lib/dashboards/types";
import { formatBytes, formatCount } from "@/lib/format";

import { kernels } from "../kernel/manager";
import { forget } from "./cache";
import { cleanupExtracts, datasetHash, extractMaxBytes, extractUrl, readManifest, updateManifest } from "./extractStore";
import type { RunDeps } from "./run";

/**
 * Building the extracts of a published dashboard (see lib/dashboards/extracts.ts):
 * each dataset that wants one is written as a Parquet file by the kernel of the
 * refresh job, then one manifest write swaps the new versions in.
 */

/**
 * The extracts a render reads: the dashboard's manifest, the serving kernel and
 * where the files are. A manifest that cannot be read (damaged, or the bucket
 * is down) is logged and taken as none, so every dataset runs live and viewers
 * still get their data.
 */
export async function servedExtracts(id: string, by: string | null = null): Promise<NonNullable<RunDeps["extracts"]>> {
  const manifest = await readManifest(id).catch((e: Error) => {
    console.error(`dashboard ${id}: extracts manifest not read, its datasets run live: ${e.message}`);
    return null;
  });
  return { manifest, serve: (method, params) => kernels.serving(method, params, by), url: (dataset, version) => extractUrl(id, dataset, version) };
}

/**
 * Builds the extract of every dataset of `p` that wants one, one after another
 * (they share the kernel), until `stopped()`. A dataset that fails keeps the
 * extract it had and the others go on. `allow` is what the queries may read
 * (null: everything); `source` is their note in the query history.
 */
export async function refreshExtracts(
  p: PublishedDashboard,
  deps: { request: RunDeps["request"]; log(line: string): void; stopped(): boolean; allow: string[] | null; source: string },
): Promise<{ built: number; failed: number }> {
  const built = new Map<string, Omit<ExtractEntry, "previous">>();
  let failed = 0;
  for (const d of p.datasets) {
    if (!wantsExtract(d)) continue;
    if (deps.stopped()) break;
    const version = newVersion(Date.now(), crypto.randomBytes(2).toString("hex"));
    try {
      const out = await deps.request("extract.write", {
        query: datasetStatement(d.sql),
        path: extractUrl(p.id, d.name, version),
        allow: deps.allow ?? ["*"],
        max_bytes: extractMaxBytes(),
        source: deps.source,
      });
      built.set(d.name, { version, rows: out.rows, bytes: out.bytes, columns: out.columns, sources: out.sources, ...(out.versions && { versions: out.versions }), hash: datasetHash(d), refreshed_at: Date.now() });
      deps.log(`${d.name}: ${formatCount(out.rows)} rows, ${formatBytes(out.bytes)}`);
    } catch (e) {
      failed++;
      deps.log(`${d.name} failed: ${(e as Error).message}`);
    }
  }
  // what the manifest holds after: the datasets that still want an extract (a dataset that is gone or live loses its entry), the new ones in place of the old
  await updateManifest(p.id, (m) => ({
    datasets: Object.fromEntries(
      p.datasets.flatMap((d) => {
        if (!wantsExtract(d)) return [];
        const old = Object.hasOwn(m.datasets, d.name) ? m.datasets[d.name] : undefined;
        const fresh = built.get(d.name);
        const entry = fresh ? { ...fresh, ...(old && { previous: old.version }) } : old;
        return entry ? [[d.name, entry] as const] : [];
      }),
    ),
  }));
  forget(p.id);
  try {
    await cleanupExtracts(p.id);
  } catch (e) {
    // the new versions are already in: old files left behind are for the next clean-up
    deps.log(`old extracts not removed: ${(e as Error).message}`);
  }
  return { built: built.size, failed };
}
