import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  cancelQuery,
  clearObjectStores,
  listFiles,
  memoryUsage,
  numThreads,
  runningQueries,
  setMemoryLimit,
  setNumThreads,
  setStorageOptions,
  storageRequests,
  version,
  fromColumns,
  interrupt,
} from "./index.js";
import { tempDir } from "./testutil.js";

test("threads, memory and version", () => {
  assert.ok(numThreads() >= 1);
  // the thread pool is set up once, by the first use: later changes are refused
  assert.throws(() => setNumThreads(2), /thread pool already initialised/);
  const usage = memoryUsage();
  assert.equal(typeof usage.used, "number");
  assert.equal(typeof usage.peak, "number");
  setMemoryLimit(null);
  assert.equal(typeof version(), "string");
});

test("storage settings: defaults for a prefix, removal, and the request counters", () => {
  setStorageOptions("s3://unused-bucket", { region: "us-east-1", allow_http: true });
  setStorageOptions("s3://unused-bucket", null);
  assert.equal(typeof storageRequests().get, "number");
  clearObjectStores();
  assert.throws(() => setStorageOptions("s3://x", { bad: [1] as unknown as string }), /must be a string, number or boolean/);
});

test("listFiles returns the files of a directory with their sizes", async () => {
  const tmp = await tempDir();
  try {
    await fromColumns({ a: [1] }).then((df) => df.writeParquet(tmp.file("one.parquet")));
    await writeFile(tmp.file("notes.txt"), "hello");
    const parquet = await listFiles(tmp.dir);
    assert.deepEqual(parquet.map((f) => f.name.endsWith("one.parquet")), [true]);
    assert.ok(parquet[0].size > 0);
    const any = await listFiles(tmp.dir, { extension: "txt" });
    assert.deepEqual(any.map((f) => f.size), [5]);
  } finally {
    await tmp.cleanup();
  }
});

test("running queries and interrupt are safe when idle", () => {
  assert.ok(Array.isArray(runningQueries()));
  assert.equal(interrupt(), 0);
});

test("cancelQuery of an unknown id reports that nothing was cancelled", () => {
  assert.equal(cancelQuery(999999999), false);
});
