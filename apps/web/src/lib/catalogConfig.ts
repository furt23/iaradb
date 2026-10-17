/**
 * The catalog text the kernels read (pure): the stored `iara.toml` text plus
 * the settings generated for the team bucket. The stored text holds only what
 * the user declared, so the generated settings are never saved with it.
 */

import { parse, stringify } from "smol-toml";

export interface KernelSettings {
  /** the default catalog's name when the text names none (kernels would fall back to their own folder's name) */
  name: string;
  /** the team bucket (`IARA_BUCKET`), null in local mode */
  bucket: string | null;
  /** the S3 endpoint of the bucket (`IARA_STORAGE_ENDPOINT`); null for cluster kernels, whose environment sends the bucket's requests to their machine's proxy */
  endpoint: string | null;
  region: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `text` with the generated settings: the workspace's name (so the Studio and
 * every kernel name the default catalog alike) and, for the team bucket, the
 * warehouse (`s3://<bucket>/warehouse`) and, with an endpoint, the bucket's
 * storage. Each is added only when the text does not set it. Unchanged when
 * nothing is generated, or when the text does not parse (the kernel reports that).
 */
export function kernelConfig(text: string, opts: KernelSettings): string {
  let cfg: Record<string, unknown>;
  try {
    cfg = parse(text) as Record<string, unknown>;
  } catch {
    return text;
  }
  const workspace = isRecord(cfg.workspace) ? { ...cfg.workspace } : {};
  const storage = isRecord(cfg.storage) ? cfg.storage : {};
  let changed = false;
  if (typeof workspace.name !== "string" || !workspace.name) {
    workspace.name = opts.name;
    cfg.workspace = workspace;
    changed = true;
  }
  if (!opts.bucket) return changed ? stringify(cfg) : text;
  const url = `s3://${opts.bucket}`;
  if (workspace.warehouse === undefined) {
    cfg.workspace = { ...workspace, warehouse: `${url}/warehouse` };
    changed = true;
  }
  if (opts.endpoint && storage[url] === undefined) {
    cfg.storage = { ...storage, [url]: { endpoint: opts.endpoint, region: opts.region } };
    changed = true;
  }
  return changed ? stringify(cfg) : text;
}
