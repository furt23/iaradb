import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { mayReadOntology, parseOntology, TEAM_ID, type Ontology } from "@/lib/ontology";

import type { StudioUser } from "../auth/access";
import { config } from "../config";
import { writeAtomic } from "../workspace/atomic";
import { catalogRegion } from "../workspace/catalogStore";

/**
 * The teams' ontologies, one `<team>.toml` each: objects under
 * `_iara/ontology/` of the team bucket, or files of the workspace's
 * `.iara/ontology` folder in local mode. People write them there, and the
 * Iara writes what owners teach her at their end, so what was read is kept for a minute,
 * not forever.
 */

const PREFIX = "_iara/ontology/";
const MAX_FILES = 200;
const MAX_BYTES = 1_000_000;
const KEEP_MS = 60_000;

// not TOML, so the file is reported as unreadable with this as the reason
const TOO_BIG = `= the file is larger than ${MAX_BYTES / 1_000_000} MB`;

export type OntologyLocation = { kind: "local"; dir: string } | { kind: "s3"; bucket: string; endpoint: string | null; region: string };

export interface OntologyFile {
  team: string;
  text: string;
}

/** The team of a file name: `finance.toml` is `finance`; anything else is no ontology. */
function teamOf(name: string): string | null {
  const team = name.endsWith(".toml") ? name.slice(0, -".toml".length) : "";
  return TEAM_ID.test(team) ? team : null;
}

async function localFiles(dir: string): Promise<OntologyFile[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: OntologyFile[] = [];
  for (const name of names.sort().slice(0, MAX_FILES)) {
    const team = teamOf(name);
    if (!team) continue;
    const file = path.join(dir, name);
    if ((await fs.stat(file)).size > MAX_BYTES) out.push({ team, text: TOO_BIG });
    else out.push({ team, text: await fs.readFile(file, "utf8") });
  }
  return out;
}

async function s3Files(location: Extract<OntologyLocation, { kind: "s3" }>, client: S3Client): Promise<OntologyFile[]> {
  // one page: at most MAX_FILES teams
  const listed = await client.send(new ListObjectsV2Command({ Bucket: location.bucket, Prefix: PREFIX, Delimiter: "/", MaxKeys: MAX_FILES }));
  const out: OntologyFile[] = [];
  for (const object of listed.Contents ?? []) {
    const team = object.Key ? teamOf(object.Key.slice(PREFIX.length)) : null;
    if (!team) continue;
    if ((object.Size ?? 0) > MAX_BYTES) {
      out.push({ team, text: TOO_BIG });
      continue;
    }
    const got = await client.send(new GetObjectCommand({ Bucket: location.bucket, Key: object.Key }));
    out.push({ team, text: (await got.Body?.transformToString("utf8")) ?? "" });
  }
  return out;
}

/** Every team's file at `location`. */
export function readOntologyFiles(location: OntologyLocation, deps: { s3?: S3Client } = {}): Promise<OntologyFile[]> {
  if (location.kind === "local") return localFiles(location.dir);
  return s3Files(location, s3Client(location, deps));
}

const s3Client = (location: Extract<OntologyLocation, { kind: "s3" }>, deps: { s3?: S3Client }) =>
  deps.s3 ?? new S3Client({ region: location.region, ...(location.endpoint ? { endpoint: location.endpoint, forcePathStyle: true } : {}) });

export interface StoredOntology {
  text: string;
  /** the ETag of the stored object (null for a local file) */
  version: string | null;
}

/** One team's file as it is stored now, null when the team has none. */
export async function readOntologyFile(location: OntologyLocation, team: string, deps: { s3?: S3Client } = {}): Promise<StoredOntology | null> {
  if (!TEAM_ID.test(team)) throw new Error(`${team} is not a team id (lowercase letters, digits, - and _)`);
  try {
    if (location.kind === "local") return { text: await fs.readFile(path.join(location.dir, `${team}.toml`), "utf8"), version: null };
    const got = await s3Client(location, deps).send(new GetObjectCommand({ Bucket: location.bucket, Key: `${PREFIX}${team}.toml` }));
    return { text: (await got.Body?.transformToString("utf8")) ?? "", version: got.ETag ?? null };
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as Error).name === "NoSuchKey" || status === 404) return null;
    throw e;
  }
}

/**
 * Stores a team's file if it still is as `was` (null: only when the team has
 * none), so what someone wrote meanwhile in the bucket is never lost. A local
 * file has no version: it is replaced.
 */
export async function writeOntologyFile(location: OntologyLocation, team: string, text: string, was: StoredOntology | null, deps: { s3?: S3Client } = {}): Promise<void> {
  if (!TEAM_ID.test(team)) throw new Error(`${team} is not a team id (lowercase letters, digits, - and _)`);
  if (location.kind === "local") return writeAtomic(path.join(location.dir, `${team}.toml`), text);
  try {
    await s3Client(location, deps).send(
      new PutObjectCommand({
        Bucket: location.bucket,
        Key: `${PREFIX}${team}.toml`,
        Body: text,
        ContentType: "text/plain; charset=utf-8",
        ...(was?.version ? { IfMatch: was.version } : { IfNoneMatch: "*" }),
      }),
    );
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 412 || (e as Error).name === "PreconditionFailed") throw new Error(`${team}.toml was changed while the draft was written: nothing was saved, try again`);
    throw e;
  }
}

export interface LoadedOntologies {
  ontologies: Ontology[];
  /** the files that could not be read as an ontology, with why */
  problems: { team: string; message: string }[];
}

/** The files as ontologies; a broken file is a problem, never a reason to lose the others. */
export function parseOntologyFiles(files: OntologyFile[]): LoadedOntologies {
  const loaded: LoadedOntologies = { ontologies: [], problems: [] };
  for (const { team, text } of files) {
    try {
      loaded.ontologies.push(parseOntology(team, text));
    } catch (e) {
      loaded.problems.push({ team, message: (e as Error).message });
    }
  }
  return loaded;
}

export function ontologyLocation(): OntologyLocation {
  if (config.bucket) return { kind: "s3", bucket: config.bucket, endpoint: config.storageEndpoint, region: catalogRegion() };
  return { kind: "local", dir: path.join(config.workspace, ".iara", "ontology") };
}

// kept on globalThis: a dev hot reload must not start a second cache
const globalForOntology = globalThis as unknown as { __iaraOntology?: { at: number; loaded: Promise<LoadedOntologies> } };

function loadOntologies(now = Date.now()): Promise<LoadedOntologies> {
  const kept = globalForOntology.__iaraOntology;
  if (kept && now - kept.at < KEEP_MS) return kept.loaded;
  const loaded = readOntologyFiles(ontologyLocation()).then(parseOntologyFiles);
  const entry = { at: now, loaded };
  globalForOntology.__iaraOntology = entry;
  loaded.catch(() => {
    if (globalForOntology.__iaraOntology === entry) globalForOntology.__iaraOntology = undefined;
  });
  return loaded;
}

/** Forget what was read: the next read takes the files from the store (after the Studio wrote one). */
export function reloadOntologies(): void {
  globalForOntology.__iaraOntology = undefined;
}

/** The ontologies `user` may read. Only admins are told of the files that are broken: their names are teams' names. */
export async function ontologiesFor(user: StudioUser, loaded: Promise<LoadedOntologies> = loadOntologies()): Promise<LoadedOntologies> {
  const { ontologies, problems } = await loaded;
  return { ontologies: ontologies.filter((o) => mayReadOntology(user, o)), problems: user.admin ? problems : [] };
}
