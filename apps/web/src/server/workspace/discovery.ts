import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import { type CatalogTable, displayName, isIdentifier } from "@/lib/catalogToml";

import { config } from "../config";

/** Table discovery: every first-level subfolder of a schema's `location` is a table. */

export interface Discovery {
  tables: CatalogTable[];
  error?: string;
}

export interface StorageConfig {
  endpoint?: string;
  region?: string;
}

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; found: Discovery }>();

/** Forget the listing of a location (all of them without one). */
export function invalidateDiscovery(location?: string): void {
  if (location === undefined) cache.clear();
  else cache.delete(location);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `endpoint` and `region` of the longest `[storage."s3://..."]` prefix that matches `location`. */
export function storageFor(cfg: unknown, location: string): StorageConfig {
  const storage = isRecord(cfg) && isRecord(cfg.storage) ? cfg.storage : {};
  let best = "";
  for (const prefix of Object.keys(storage)) {
    if (location.startsWith(prefix) && prefix.length > best.length) best = prefix;
  }
  const spec = best ? storage[best] : null;
  if (!isRecord(spec)) return {};
  return {
    endpoint: typeof spec.endpoint === "string" && spec.endpoint ? spec.endpoint : undefined,
    region: typeof spec.region === "string" && spec.region ? spec.region : undefined,
  };
}

/** The table named by a folder, or null for hidden/underscore folders and names that are not identifiers. */
export function tableForFolder(schema: string, folder: string, base: string): CatalogTable | null {
  if (folder.startsWith("_") || folder.startsWith(".") || !isIdentifier(folder)) return null;
  const table = folder.toLowerCase();
  const sep = base.endsWith("/") ? "" : "/";
  const tablePath = `${base}${sep}${folder}/`;
  return { name: displayName({ schema, table }), schema, table, path: tablePath, format: "parquet", discovered: true };
}

function localFolders(location: string): string {
  return path.resolve(config.workspace, location);
}

async function listLocal(location: string): Promise<string[]> {
  const entries = await fs.readdir(localFolders(location), { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

function splitS3(location: string): { bucket: string; prefix: string } {
  const rest = location.slice("s3://".length);
  const slash = rest.indexOf("/");
  const bucket = slash < 0 ? rest : rest.slice(0, slash);
  let prefix = slash < 0 ? "" : rest.slice(slash + 1);
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return { bucket, prefix };
}

async function listS3(location: string, storage: StorageConfig): Promise<string[]> {
  const { bucket, prefix } = splitS3(location);
  if (!bucket) throw new Error("no bucket in the location");
  const client = new S3Client({
    region: storage.region ?? "us-east-1",
    ...(storage.endpoint ? { endpoint: storage.endpoint, forcePathStyle: true } : {}),
  });
  try {
    const folders: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: "/", ContinuationToken: token }),
      );
      for (const p of page.CommonPrefixes ?? []) {
        if (p.Prefix) folders.push(p.Prefix.slice(prefix.length).replace(/\/+$/, ""));
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return folders;
  } finally {
    client.destroy();
  }
}

function failure(location: string, e: unknown): Discovery {
  const err = e as { name?: string; code?: string; message?: string };
  const code = err.code === "ENOENT" ? "the folder does not exist" : err.message || err.name || "unknown error";
  return { tables: [], error: `could not list ${location}: ${code}` };
}

/** The tables found under a schema's location (cached 30 s); a failure is returned, not thrown. */
export async function discoverTables(schema: string, location: string, cfg: unknown): Promise<Discovery> {
  const hit = cache.get(location);
  const found = hit && Date.now() - hit.at < TTL_MS ? hit.found : await list(location, cfg);
  if (found !== hit?.found) cache.set(location, { at: Date.now(), found });
  return { ...found, tables: found.tables.map((t) => ({ ...t, ...rename(schema, t) })) };
}

/** The cache is by location, shared by schemas: names follow the asking schema. */
function rename(schema: string, t: CatalogTable): Partial<CatalogTable> {
  return { schema, name: displayName({ schema, table: t.table }) };
}

async function list(location: string, cfg: unknown): Promise<Discovery> {
  try {
    const s3 = location.startsWith("s3://");
    const folders = s3 ? await listS3(location, storageFor(cfg, location)) : await listLocal(location);
    const tables = folders.flatMap((f) => tableForFolder("", f, location) ?? []);
    return { tables };
  } catch (e) {
    return failure(location, e);
  }
}
