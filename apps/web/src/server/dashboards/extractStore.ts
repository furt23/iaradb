import "server-only";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { ID } from "@/lib/dashboards/config";
import { checkManifest, emptyManifest, type ExtractManifest, VERSION } from "@/lib/dashboards/extracts";
import { DATASET_NAME } from "@/lib/dashboards/query";
import { recipeJson } from "@/lib/dashboards/recipe";
import type { Dataset } from "@/lib/dashboards/types";

import { config } from "../config";
import { writeAtomic } from "../workspace/atomic";
import { catalogRegion } from "../workspace/catalogStore";

/**
 * Where the extracts of dashboards are kept (see lib/dashboards/extracts.ts):
 * `extracts/<dashboard-id>/manifest.json` and `extracts/<dashboard-id>/<dataset>/<version>.parquet`
 * under `_iara/` of the team bucket, or under the workspace's hidden `.iara/`
 * folder without one, as the catalog is (workspace/catalogStore.ts). The
 * Parquet files are written by kernels; the Studio keeps the manifest.
 */

const BUCKET_ROOT = "_iara/extracts/";
const MANIFEST = "manifest.json";
/** how many times a manifest write that lost a race starts over */
const ATTEMPTS = 5;
/** a file no manifest names yet may be a refresh still running: it is left alone for this long after its version's time */
const IN_FLIGHT_MS = 6 * 3600_000;

/** a manifest write refused because another writer got there first */
class Conflict extends Error {}

interface Stored {
  text: string;
  /** the ETag of the object (null for a local file) */
  version: string | null;
}

/** Storage under `extracts/`: `rel` is a path inside it, always with `/`. */
interface Backend {
  /** where a kernel reads or writes it */
  url(rel: string): string;
  read(rel: string): Promise<Stored | null>;
  /** replaces the file if it still has `version` (null: only when there is none); a lost race throws Conflict */
  write(rel: string, text: string, version: string | null): Promise<void>;
  /** every file under the folder `prefix`, as paths from `extracts/` */
  list(prefix: string): Promise<string[]>;
  remove(rels: string[]): Promise<void>;
  removeTree(prefix: string): Promise<void>;
}

function localBackend(root: string): Backend {
  const at = (rel: string) => path.join(root, ...rel.split("/"));
  return {
    url: at,
    async read(rel) {
      try {
        return { text: await fs.readFile(at(rel), "utf8"), version: null };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    // the Studio is the only writer and updateManifest queues its calls: nothing to compare
    write: (rel, text) => writeAtomic(at(rel), text),
    async list(prefix) {
      try {
        return (await fs.readdir(at(prefix), { recursive: true })).map((name) => `${prefix}/${name.replaceAll("\\", "/")}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
    },
    async remove(rels) {
      for (const rel of rels) await fs.rm(at(rel), { force: true });
    },
    removeTree: (prefix) => fs.rm(at(prefix), { recursive: true, force: true }),
  };
}

function statusOf(e: unknown): number | undefined {
  return (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

// the same client as the catalog's (workspace/catalogStore.ts): keys from the environment, path style behind an endpoint
let client: S3Client | undefined;
function s3(): S3Client {
  return (client ??= new S3Client({
    region: catalogRegion(),
    ...(config.storageEndpoint ? { endpoint: config.storageEndpoint, forcePathStyle: true } : {}),
  }));
}

function s3Backend(bucket: string): Backend {
  const key = (rel: string) => `${BUCKET_ROOT}${rel}`;
  const backend: Backend = {
    url: (rel) => `s3://${bucket}/${key(rel)}`,
    async read(rel) {
      try {
        const out = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key(rel) }));
        return { text: (await out.Body?.transformToString("utf8")) ?? "", version: out.ETag ?? null };
      } catch (e) {
        if ((e as Error).name === "NoSuchKey" || (e as Error).name === "NotFound" || statusOf(e) === 404) return null;
        throw e;
      }
    },
    async write(rel, text, version) {
      try {
        await s3().send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key(rel),
            Body: text,
            ContentType: "application/json",
            // replace the version read; a first write must not replace anything
            ...(version ? { IfMatch: version } : { IfNoneMatch: "*" }),
          }),
        );
      } catch (e) {
        // 409: a write of the same object was in progress
        if (statusOf(e) === 412 || statusOf(e) === 409 || (e as Error).name === "PreconditionFailed") throw new Conflict("the extracts manifest was changed by another writer");
        throw e;
      }
    },
    async list(prefix) {
      const out: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: key(`${prefix}/`), ContinuationToken: token }));
        for (const o of page.Contents ?? []) if (o.Key) out.push(o.Key.slice(BUCKET_ROOT.length));
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async remove(rels) {
      // one by one: DeleteObject is the call every S3-compatible store has, and there are few files
      for (const rel of rels) await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key(rel) }));
    },
    async removeTree(prefix) {
      await backend.remove(await backend.list(prefix));
    },
  };
  return backend;
}

function backend(): Backend {
  return config.bucket ? s3Backend(config.bucket) : localBackend(path.join(config.workspace, ".iara", "extracts"));
}

function checkedId(id: string): string {
  if (!ID.test(id)) throw new Error(`invalid dashboard id ${id}`);
  return id;
}

// kept on globalThis: a dev hot reload must not start a second set of queues
const globalForLocks = globalThis as unknown as { __iaraExtractLocks?: Map<string, Promise<unknown>> };

/** Runs `fn` after the earlier calls for the same dashboard (a read-modify-write of the manifest, a clean-up, a delete). */
function exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalForLocks.__iaraExtractLocks ??= new Map());
  const run = (locks.get(id) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  void tail.then(() => {
    if (locks.get(id) === tail) locks.delete(id);
  });
  return run;
}

/** sha1 hex of what the dataset is: its recipe (recipeJson) when it has one, else its SQL trimmed. */
export function datasetHash(d: Dataset): string {
  return crypto.createHash("sha1").update(d.recipe ? recipeJson(d.recipe) : d.sql.trim()).digest("hex");
}

/** IARA_EXTRACT_MAX_MB (default 100) in bytes. */
export function extractMaxBytes(): number {
  const mb = Number(process.env.IARA_EXTRACT_MAX_MB);
  return Math.floor((Number.isFinite(mb) && mb > 0 ? mb : 100) * 1024 * 1024);
}

/**
 * Where a version of a dataset's extract lives: `s3://<bucket>/_iara/extracts/<id>/<dataset>/<version>.parquet`
 * with a bucket, else the absolute path `<workspace>/.iara/extracts/<id>/<dataset>/<version>.parquet`.
 * The names are checked: they end up in a path.
 */
export function extractUrl(id: string, dataset: string, version: string): string {
  if (!DATASET_NAME.test(dataset)) throw new Error(`invalid dataset name ${dataset}`);
  if (!VERSION.test(version)) throw new Error(`invalid extract version ${version}`);
  return backend().url(`${checkedId(id)}/${dataset}/${version}.parquet`);
}

async function load(b: Backend, id: string): Promise<{ manifest: ExtractManifest | null; version: string | null }> {
  const stored = await b.read(`${checkedId(id)}/${MANIFEST}`);
  if (!stored) return { manifest: null, version: null };
  try {
    return { manifest: checkManifest(JSON.parse(stored.text)), version: stored.version };
  } catch (e) {
    // never rewritten from nothing: the other datasets' entries would be lost
    throw new Error(`the extracts manifest of dashboard ${id} is damaged: ${(e as Error).message}`);
  }
}

/** The dashboard's manifest (null: none yet); a damaged file throws. */
export async function readManifest(id: string): Promise<ExtractManifest | null> {
  return (await load(backend(), id)).manifest;
}

/**
 * Read-modify-write of the manifest: If-Match on the bucket (retried a few
 * times on a conflict, so `change` may run more than once), an atomic write
 * locally. Calls in this process run one after the other. What `change`
 * returns is checked before it is written, so a bug there cannot leave a
 * manifest that readers refuse.
 */
export async function updateManifest(id: string, change: (m: ExtractManifest) => ExtractManifest): Promise<ExtractManifest> {
  return exclusive(checkedId(id), async () => {
    const b = backend();
    for (let attempt = 1; ; attempt++) {
      const { manifest, version } = await load(b, id);
      const next = checkManifest(change(manifest ?? emptyManifest()));
      try {
        await b.write(`${id}/${MANIFEST}`, `${JSON.stringify(next, null, 2)}\n`, version);
        return next;
      } catch (e) {
        if (!(e instanceof Conflict) || attempt === ATTEMPTS) throw e;
      }
    }
  });
}

/** The time a version's name holds (NaN: not a version). */
function versionTime(version: string): number {
  return VERSION.test(version) ? Date.parse(version.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z.*$/, "$1-$2-$3T$4:$5:$6Z")) : Number.NaN;
}

/**
 * Deletes the Parquet files under the dashboard's extracts that the manifest
 * names neither as `version` nor `previous` (orphans of failed refreshes
 * included). A refresh writes its file before the manifest names it, so a file
 * newer than its dataset's current version is kept for a few hours: it may be
 * a refresh still running.
 */
export async function cleanupExtracts(id: string): Promise<void> {
  return exclusive(checkedId(id), async () => {
    const b = backend();
    const { manifest } = await load(b, id);
    const named = new Set<string>();
    const current = new Map<string, number>();
    for (const [name, e] of Object.entries(manifest?.datasets ?? {})) {
      for (const v of [e.version, e.previous]) if (v) named.add(`${id}/${name}/${v}.parquet`);
      current.set(name, versionTime(e.version));
    }
    const now = Date.now();
    await b.remove(
      (await b.list(id)).filter((rel) => {
        const m = /^[^/]+\/([^/]+)\/([^/]+)\.parquet$/.exec(rel);
        if (!m || named.has(rel)) return false;
        const t = versionTime(m[2]);
        return !(t > (current.get(m[1]) ?? 0) && now - t < IN_FLIGHT_MS);
      }),
    );
  });
}

/** Deletes everything of the dashboard's extracts (the dashboard was deleted). */
export async function deleteExtracts(id: string): Promise<void> {
  return exclusive(checkedId(id), () => backend().removeTree(id));
}
