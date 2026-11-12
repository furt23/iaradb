import {
  deltaHistory as nativeDeltaHistory,
  deltaInfo as nativeDeltaInfo,
  listFiles as nativeListFiles,
  setStorageOptions as nativeSetStorageOptions,
  type DeltaCommit,
  type DeltaInfo,
  type FileEntry,
} from "../native/index.js";

export {
  cancelQuery,
  clearObjectStores,
  interrupt,
  memoryUsage,
  numThreads,
  runningQueries,
  setMemoryLimit,
  setNumThreads,
  storageRequests,
  version,
} from "../native/index.js";
export type { DeltaCommit, DeltaInfo, DeltaWrite, FileEntry, MemoryUsage, Requests, RunningQuery } from "../native/index.js";

/** Storage settings by key (object_store's names: `region`, `endpoint`, `access_key_id` ...). */
export type StorageOptions = Record<string, string | number | boolean | null | undefined>;

/** Checks a storage options object (string keys, scalar values) and copies it; undefined for none. */
export function normalizeStorageOptions(options: StorageOptions | null | undefined): Record<string, unknown> | undefined {
  if (options === null || options === undefined) return undefined;
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError(`storageOptions must be an object, got ${Array.isArray(options) ? "an array" : typeof options}`);
  }
  for (const [key, value] of Object.entries(options)) {
    if (value !== null && value !== undefined && !["string", "number", "boolean"].includes(typeof value)) {
      throw new TypeError(`storage option "${key}" must be a string, number or boolean`);
    }
  }
  return { ...options };
}

/** Default options for every URL under `prefix` (null or an empty object removes them). */
export function setStorageOptions(prefix: string, options: StorageOptions | null = null): void {
  nativeSetStorageOptions(prefix, normalizeStorageOptions(options) ?? null);
}

/** The files of a path, directory, glob or URL with their sizes; `extension` filters a directory listing. */
export function listFiles(
  pattern: string,
  options: { extension?: string; storageOptions?: StorageOptions } = {},
): Promise<FileEntry[]> {
  return nativeListFiles(pattern, options.extension ?? "parquet", normalizeStorageOptions(options.storageOptions));
}

/** The Delta table at `path`, at its newest version. */
export function deltaInfo(path: string, options: { storageOptions?: StorageOptions } = {}): Promise<DeltaInfo> {
  return nativeDeltaInfo(path, normalizeStorageOptions(options.storageOptions));
}

/** The commits of the Delta table at `path`, newest first (at most `limit`). */
export function deltaHistory(
  path: string,
  options: { storageOptions?: StorageOptions; limit?: number } = {},
): Promise<DeltaCommit[]> {
  return nativeDeltaHistory(path, normalizeStorageOptions(options.storageOptions), options.limit ?? null);
}
