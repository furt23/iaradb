import { parse } from "smol-toml";

/**
 * The S3 buckets a workspace reads (pure; unit tested): those of its tables'
 * paths and of its `[storage."s3://..."]` sections. Clusters get access to
 * exactly these (until profiles decide per user).
 */
export function bucketsOf(configText: string | null): string[] {
  if (!configText) return [];
  let cfg: Record<string, unknown>;
  try {
    cfg = parse(configText) as Record<string, unknown>;
  } catch {
    return [];
  }
  const urls: string[] = [];
  for (const t of Object.values((cfg.tables ?? {}) as Record<string, { path?: unknown }>)) {
    if (typeof t?.path === "string") urls.push(t.path);
  }
  urls.push(...Object.keys((cfg.storage ?? {}) as Record<string, unknown>));
  const buckets = urls.flatMap((u) => {
    const m = /^s3a?:\/\/([^/]+)/i.exec(u.trim());
    return m ? [m[1]] : [];
  });
  return [...new Set(buckets)].sort();
}
