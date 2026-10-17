import "server-only";

import fs from "node:fs";
import path from "node:path";

/**
 * Studio configuration, from the environment set by `iara serve`:
 *
 * - `IARA_WORKSPACE`: workspace root (default: the repository's example workspace)
 * - `IARA_PYTHON`: Python interpreter with `iara` installed
 *   (default: the repository's `.venv`, else `python` on PATH)
 * - `IARA_BUCKET`: team mode: the S3 bucket that holds the catalog (at `_iara/catalog.toml`)
 *   and the warehouse (default: the catalog is a hidden file of the workspace)
 * - `IARA_STORAGE_ENDPOINT`: the S3 endpoint of `IARA_BUCKET`, for example
 *   `https://<account>.r2.cloudflarestorage.com` (no bucket in it)
 */
export interface StudioConfig {
  workspace: string;
  python: string;
  /** minutes a kernel may stay unused before it is shut down */
  idleMinutes: number;
  /** the team's S3 bucket (null: the catalog is a file of the workspace) */
  bucket: string | null;
  /** the S3 endpoint of `bucket` (null: AWS) */
  storageEndpoint: string | null;
}

const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function findUp(start: string, marker: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function defaultPython(repo: string | null): string {
  if (repo) {
    for (const rel of [".venv/Scripts/python.exe", ".venv/bin/python"]) {
      const p = path.join(repo, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

function bucketFrom(raw: string | undefined): string | null {
  const bucket = raw?.trim() || null;
  if (bucket && !BUCKET_NAME.test(bucket)) throw new Error(`IARA_BUCKET "${bucket}" is not a valid S3 bucket name`);
  return bucket;
}

function endpointFrom(raw: string | undefined): string | null {
  const endpoint = raw?.trim().replace(/\/+$/, "") || null;
  if (endpoint && !/^https?:\/\//.test(endpoint)) {
    throw new Error(`IARA_STORAGE_ENDPOINT "${endpoint}" must start with https:// or http://`);
  }
  return endpoint;
}

function loadConfig(): StudioConfig {
  const repo = findUp(process.cwd(), "pyproject.toml");
  const example = repo ? path.join(repo, "examples", "workspace") : null;
  const workspace = process.env.IARA_WORKSPACE || (example && fs.existsSync(example) ? example : process.cwd());
  return {
    workspace: path.resolve(workspace),
    python: process.env.IARA_PYTHON || defaultPython(repo),
    idleMinutes: Number(process.env.IARA_KERNEL_IDLE_MINUTES || 60),
    bucket: bucketFrom(process.env.IARA_BUCKET),
    storageEndpoint: endpointFrom(process.env.IARA_STORAGE_ENDPOINT),
  };
}

export const config: StudioConfig = loadConfig();
