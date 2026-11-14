import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config";
import { writeAtomic } from "../workspace/atomic";
import { systemDir } from "./paths";

/**
 * Where published tables are kept, as dashboards' extracts are (dashboards/extractStore.ts):
 * `s3://<bucket>/_iara/system/<table>/<name>.parquet` with a team bucket, else
 * `<workspace>/.iara/system/<table>/<name>.parquet`.
 */

function folder(table: string): string {
  return config.bucket ? `s3://${config.bucket}/_iara/system/${table}` : path.join(config.workspace, ".iara", "system", table);
}

/** The folder of a published table: what the catalog points at. */
export function tableUrl(table: string): string {
  return folder(table);
}

/** A file of a published table (`name` is a day, or `snapshot`). */
export function publishedUrl(table: string, name: string): string {
  return config.bucket ? `${folder(table)}/${name}.parquet` : path.join(folder(table), `${name}.parquet`);
}

function publishedFile(): string {
  return path.join(systemDir(), "published.json");
}

/** What was published, by `<table>/<file>`: the size and modification time of the JSON lines file it was made from. */
type Published = Map<string, string>;

// read once and kept on globalThis: the catalog asks on every kernel request, and on Windows a rename
// over a file another read holds open fails
const g = globalThis as { __iaraPublished?: Promise<Published> };

/** A damaged or missing file counts as nothing published: the next publish rewrites it. */
async function readPublished(): Promise<Published> {
  try {
    const files: unknown = JSON.parse(await fs.readFile(publishedFile(), "utf8"));
    if (!files || typeof files !== "object" || Array.isArray(files)) return new Map();
    return new Map(Object.entries(files).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return new Map();
  }
}

/** What was published so far (kept across restarts, so a restart publishes only what changed). */
export function publishedFiles(): Promise<Published> {
  return (g.__iaraPublished ??= readPublished());
}

/** The tables published at least once. */
export async function publishedTables(): Promise<string[]> {
  return [...new Set([...(await publishedFiles()).keys()].map((key) => key.split("/")[0]))];
}

/** Records a publish; a failure to save it only costs publishing that file again after a restart. */
export async function markPublished(key: string, signature: string): Promise<void> {
  const published = await publishedFiles();
  published.set(key, signature);
  try {
    await writeAtomic(publishedFile(), JSON.stringify(Object.fromEntries(published)));
  } catch (e) {
    console.error(`system catalog: what was published is not saved: ${(e as Error).message}`);
  }
}
