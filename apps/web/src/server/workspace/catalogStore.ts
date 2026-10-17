import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { kernelConfig } from "@/lib/catalogConfig";

import { config } from "../config";
import { writeAtomic } from "./atomic";

/**
 * The catalog (the text of `iara.toml`) is kept by the Studio, out of the
 * workspace's visible files: a hidden file in local mode, an object of the team
 * bucket otherwise. The Studio is the only writer, so the text is cached until
 * a write or `reloadCatalog`.
 */

/** The workspace file the catalog is imported from on its first use. */
const IMPORT_NAME = "iara.toml";
/** The object of the team bucket that holds the catalog. */
const OBJECT_KEY = "_iara/catalog.toml";

type S3Location = { kind: "s3"; bucket: string; key: string; endpoint: string | null; region: string };

export type CatalogLocation = { kind: "local"; file: string } | S3Location;

export interface StoredCatalog {
  text: string;
  /** the ETag of the stored object (null for a local file) */
  version: string | null;
}

export interface CatalogStore {
  /** The stored catalog, null when nothing is stored yet. */
  read(): Promise<StoredCatalog | null>;
  /**
   * Store `text` if the stored catalog still has `version` (null: only when
   * nothing is stored yet). Returns the new version.
   */
  write(text: string, version: string | null): Promise<string | null>;
}

export interface CatalogStoreDeps {
  s3?: S3Client;
}

export function createCatalogStore(location: CatalogLocation, deps: CatalogStoreDeps = {}): CatalogStore {
  if (location.kind === "local") return localStore(location.file);
  const client =
    deps.s3 ??
    new S3Client({
      region: location.region,
      ...(location.endpoint ? { endpoint: location.endpoint, forcePathStyle: true } : {}),
    });
  return s3Store(location, client);
}

function localStore(file: string): CatalogStore {
  return {
    async read() {
      try {
        return { text: await fs.readFile(file, "utf8"), version: null };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    async write(text) {
      await writeAtomic(file, text);
      return null;
    },
  };
}

function statusOf(e: unknown): number | undefined {
  return (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

function s3Store(location: S3Location, client: S3Client): CatalogStore {
  const target = { Bucket: location.bucket, Key: location.key };
  return {
    async read() {
      try {
        const out = await client.send(new GetObjectCommand(target));
        return { text: (await out.Body?.transformToString("utf8")) ?? "", version: out.ETag ?? null };
      } catch (e) {
        const name = (e as Error).name;
        if (name === "NoSuchKey" || name === "NotFound" || statusOf(e) === 404) return null;
        throw e;
      }
    },
    async write(text, version) {
      try {
        const out = await client.send(
          new PutObjectCommand({
            ...target,
            Body: text,
            ContentType: "text/plain; charset=utf-8",
            // replace the version read; a first store must not replace anything
            ...(version ? { IfMatch: version } : { IfNoneMatch: "*" }),
          }),
        );
        return out.ETag ?? null;
      } catch (e) {
        if (statusOf(e) === 412 || (e as Error).name === "PreconditionFailed") {
          throw new Error("the catalog was changed by another Studio: reload the page");
        }
        throw e;
      }
    },
  };
}

/** The team bucket's region (`AWS_REGION`, else "auto" as R2 takes it). */
export function catalogRegion(): string {
  return process.env.AWS_REGION || "auto";
}

/** The workspace's name when its catalog names none: `IARA_TEAM`, else the folder's name. */
export function defaultWorkspaceName(): string {
  return process.env.IARA_TEAM || path.basename(config.workspace);
}

function catalogLocation(): CatalogLocation {
  if (config.bucket) {
    return { kind: "s3", bucket: config.bucket, key: OBJECT_KEY, endpoint: config.storageEndpoint, region: catalogRegion() };
  }
  return { kind: "local", file: path.join(config.workspace, ".iara", "catalog.toml") };
}

interface CatalogState {
  store: CatalogStore;
  /** the catalog as read or written by this process; null until the first read */
  cached: Promise<StoredCatalog> | null;
}

// kept on globalThis: a dev hot reload must not start a second cache
const globalForCatalog = globalThis as unknown as { __iaraCatalog?: CatalogState };

function state(): CatalogState {
  return (globalForCatalog.__iaraCatalog ??= { store: createCatalogStore(catalogLocation()), cached: null });
}

async function importedText(): Promise<string | null> {
  try {
    return await fs.readFile(path.join(config.workspace, IMPORT_NAME), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * A catalog nobody stored yet: the workspace's iara.toml imported (it is left
 * in place; given a `[workspace] name` when it has none), else a new one.
 */
async function seed(store: CatalogStore): Promise<StoredCatalog> {
  const imported = await importedText();
  const name = defaultWorkspaceName();
  const text =
    imported === null
      ? `[workspace]\nname = ${JSON.stringify(name)}\n`
      : kernelConfig(imported, { name, bucket: null, endpoint: null, region: catalogRegion() });
  return { text, version: await store.write(text, null) };
}

/** The cached catalog; the first read takes it from the store (one read at a time). */
function loaded(s: CatalogState): Promise<StoredCatalog> {
  if (!s.cached) {
    const pending = (async () => (await s.store.read()) ?? (await seed(s.store)))();
    s.cached = pending;
    pending.catch(() => {
      if (s.cached === pending) s.cached = null;
    });
  }
  return s.cached;
}

/** The catalog text the Studio keeps. */
export async function readCatalogText(): Promise<string> {
  return (await loaded(state())).text;
}

/** Store the catalog text; a stored catalog changed since this Studio read it is refused. */
export async function writeCatalogText(text: string): Promise<void> {
  const s = state();
  const { version } = await loaded(s);
  try {
    const next = await s.store.write(text, version);
    s.cached = Promise.resolve({ text, version: next });
  } catch (e) {
    // the cache may be stale: the next read takes the stored catalog again
    s.cached = null;
    throw e;
  }
}

/** Forget the cached catalog: the next read takes it from the store. */
export function reloadCatalog(): void {
  state().cached = null;
}
