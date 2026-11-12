import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  col,
  deltaHistory,
  deltaInfo,
  fromColumns,
  readCsv,
  readDelta,
  readJson,
  readNdjson,
  readParquet,
  scanCsv,
  scanDelta,
  scanJson,
  scanNdjson,
  scanParquet,
} from "./index.js";
import { sampleFrame, tempDir } from "./testutil.js";

test("Parquet round trip through writeParquet and readParquet", async () => {
  const tmp = await tempDir();
  try {
    const df = await sampleFrame();
    await df.writeParquet(tmp.file("t.parquet"));
    const back = await readParquet(tmp.file("t.parquet"));
    assert.deepEqual(await back.toColumns(), await df.toColumns());
    const lazy = await scanParquet(tmp.file("t.parquet"));
    assert.equal((await lazy.filter(col("a").gt(2)).collect()).height, 2);
  } finally {
    await tmp.cleanup();
  }
});

test("CSV round trip, with separator, null values, columns and schema overrides", async () => {
  const tmp = await tempDir();
  try {
    const df = await fromColumns({ a: [1, 2, null], s: ["x", "NA", "z"] });
    await df.writeCsv(tmp.file("t.csv"), { separator: ";" });
    const plain = await readCsv(tmp.file("t.csv"), { separator: ";" });
    assert.deepEqual(plain.columns, ["a", "s"]);
    assert.deepEqual((await plain.toColumns()).a, [1, 2, null]);
    const nulls = await readCsv(tmp.file("t.csv"), { separator: ";", nullValues: "NA" });
    assert.deepEqual((await nulls.toColumns()).s, ["x", null, "z"]);
    const typed = await scanCsv(tmp.file("t.csv"), { separator: ";", schemaOverrides: { a: "utf8" } });
    assert.equal(typed.schema.a, "Utf8");
    const kept = await scanCsv(tmp.file("t.csv"), { separator: ";", columns: ["s"] });
    assert.deepEqual(kept.columns, ["s"]);
  } finally {
    await tmp.cleanup();
  }
});

test("NDJSON round trip, and a JSON array file", async () => {
  const tmp = await tempDir();
  try {
    const df = await fromColumns({ id: [1, 2], tags: [["a"], ["b", "c"]], meta: [{ k: true }, { k: false }] });
    await df.writeNdjson(tmp.file("t.ndjson"));
    const back = await readNdjson(tmp.file("t.ndjson"));
    assert.deepEqual(await back.toRecords(), await df.toRecords());
    const lazy = await scanNdjson(tmp.file("t.ndjson"));
    assert.equal((await lazy.collect()).height, 2);

    await writeFile(tmp.file("arr.json"), JSON.stringify([{ n: 1 }, { n: 2 }, { n: 3 }]));
    const fromArray = await readJson(tmp.file("arr.json"));
    assert.deepEqual((await fromArray.toColumns()).n, [1, 2, 3]);
    const scanned = await scanJson(tmp.file("arr.json"));
    assert.equal((await scanned.collect()).height, 3);
  } finally {
    await tmp.cleanup();
  }
});

test("Delta: versions, time travel and table info", async () => {
  const tmp = await tempDir();
  try {
    const df = await sampleFrame();
    const path = tmp.file("delta");
    await df.writeDelta(path);
    await df.writeDelta(path, { mode: "append" });

    assert.equal((await readDelta(path)).height, 10);
    assert.equal((await readDelta(path, { version: 0 })).height, 5);
    const lazy = await scanDelta(path, { version: 0 });
    assert.equal((await lazy.collect()).height, 5);
    // a timestamp after the last commit reads the newest version
    const future = await scanDelta(path, { timestamp: new Date(Date.now() + 60_000) });
    assert.equal((await future.collect()).height, 10);

    const info = await deltaInfo(path);
    assert.equal(info.version, 1);
    const history = await deltaHistory(path, { limit: 5 });
    assert.deepEqual(
      history.map((c) => c.version),
      [1, 0],
    );
  } finally {
    await tmp.cleanup();
  }
});

test("storage options must be an object of scalar values", async () => {
  await assert.rejects(
    readCsv("nowhere.csv", { storageOptions: { region: { bad: 1 } as unknown as string } }),
    /must be a string, number or boolean/,
  );
  await assert.rejects(
    readParquet("nowhere.parquet", { storageOptions: ["x"] as unknown as Record<string, string> }),
    /must be an object/,
  );
});
