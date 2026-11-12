import { test } from "node:test";
import assert from "node:assert/strict";
import * as arrow from "apache-arrow";
import { col, fromArrow, fromColumns, SessionContext, type DataFrame } from "./index.js";
import { sampleFrame, tempDir } from "./testutil.js";

test("register frames, tables and files, then query them with sql", async () => {
  const tmp = await tempDir();
  try {
    const df: DataFrame = await sampleFrame();
    await df.writeParquet(tmp.file("p.parquet"));
    await df.writeCsv(tmp.file("c.csv"));
    const ctx = new SessionContext();
    await ctx.register("frame", df);
    await ctx.register("lazy", df.lazy());
    await ctx.register("file", tmp.file("p.parquet"));
    await ctx.register("csv", tmp.file("c.csv"));
    await ctx.register("table", arrow.tableFromArrays({ k: new Int32Array([1, 2]) }));
    assert.deepEqual(ctx.tables().sort(), ["csv", "file", "frame", "lazy", "table"]);
    for (const name of ["frame", "lazy", "file", "csv"]) {
      const out = await (await ctx.sql(`select count(*) as n from ${name}`)).collect();
      assert.deepEqual(await out.toRecords(), [{ n: 5 }], name);
    }
    const sum = await (await ctx.sql("select sum(k) as s from \"table\"")).collect();
    assert.deepEqual(await sum.toRecords(), [{ s: 3 }]);
  } finally {
    await tmp.cleanup();
  }
});

test("table(), readers and fromArrow on a session", async () => {
  const tmp = await tempDir();
  try {
    const df = await sampleFrame();
    await df.writeParquet(tmp.file("p.parquet"));
    const ctx = new SessionContext();
    await ctx.register("t", df);
    assert.equal((await (await ctx.table("t")).collect()).height, 5);
    assert.equal((await (await ctx.readParquet(tmp.file("p.parquet"))).collect()).height, 5);
    const lf = await ctx.fromArrow(arrow.tableFromArrays({ z: new Int32Array([7]) }));
    assert.deepEqual(await (await lf.collect()).toRecords(), [{ z: 7 }]);
  } finally {
    await tmp.cleanup();
  }
});

test("catalog accessors and registrations", async () => {
  const ctx = new SessionContext();
  assert.ok(ctx.catalogs().length >= 1);
  assert.equal(ctx.currentSchema(), "main");
  assert.equal(ctx.defaultCatalog(), ctx.currentCatalog());
  assert.ok(ctx.schemas().includes("main"));
  assert.equal(ctx.warehouse, null);
  await ctx.register("t", await fromColumns({ a: [1] }));
  assert.equal(ctx.isLoaded("t"), true);
  assert.equal(ctx.isLoaded("nothing"), null);
  assert.equal(ctx.deregister("t"), true);
  assert.equal(ctx.deregister("t"), false);
});

test("a lazily registered Parquet table loads on first use", async () => {
  const tmp = await tempDir();
  try {
    const df = await sampleFrame();
    await df.writeParquet(tmp.file("p.parquet"));
    const ctx = new SessionContext();
    await ctx.registerParquet("p", tmp.file("p.parquet"), { lazy: true });
    assert.equal(ctx.isLoaded("p"), false);
    assert.equal((await (await ctx.sql("select count(*) as n from p")).collect()).height, 1);
    assert.equal(ctx.isLoaded("p"), true);
  } finally {
    await tmp.cleanup();
  }
});

test("fork starts with the same tables, and registrations stay independent", async () => {
  const ctx = new SessionContext();
  await ctx.register("shared", await fromColumns({ a: [1, 2] }));
  const child = ctx.fork();
  await child.register("only_child", await fromColumns({ a: [9] }));
  assert.ok(child.tables().includes("shared"));
  assert.ok(child.tables().includes("only_child"));
  assert.ok(!ctx.tables().includes("only_child"));
});

test("sql with positional params, then the frame API on its result", async () => {
  const ctx = new SessionContext();
  await ctx.register("nums", await fromColumns({ n: [1, 2, 3] }));
  const out = await (await ctx.sql("select n from nums where n > $1", [1])).filter(col("n").gt(2)).collect();
  assert.deepEqual(await out.toRecords(), [{ n: 3 }]);
});

test("the other registrations and readers of a session", async () => {
  const tmp = await tempDir();
  try {
    const df = await sampleFrame();
    await df.writeDelta(tmp.file("delta"));
    await df.writeCsv(tmp.file("c.csv"));
    await df.writeNdjson(tmp.file("j.ndjson"));
    await df.writeParquet(tmp.file("tbl.parquet"));
    const ctx = new SessionContext();
    await ctx.registerDelta("d", tmp.file("delta"));
    await ctx.registerCsv("c", tmp.file("c.csv"));
    await ctx.registerJson("j", tmp.file("j.ndjson"));
    await ctx.registerTable("tb", tmp.file("tbl.parquet"));
    for (const name of ["d", "c", "j", "tb"]) {
      assert.equal((await (await ctx.sql(`select count(*) as n from ${name}`)).collect()).height, 1, name);
    }
    assert.equal((await (await ctx.readDelta(tmp.file("delta"))).collect()).height, 5);
    assert.equal((await (await ctx.readCsv(tmp.file("c.csv"))).collect()).height, 5);
    assert.equal((await (await ctx.readJson(tmp.file("j.ndjson"))).collect()).height, 5);
    ctx.setWarehouse(tmp.dir);
    assert.equal(ctx.warehouse, tmp.dir);
  } finally {
    await tmp.cleanup();
  }
});

test("top-level fromArrow", async () => {
  const df = await fromArrow(arrow.tableFromArrays({ q: new Int32Array([4, 5]) }));
  assert.deepEqual(await df.toRecords(), [{ q: 4 }, { q: 5 }]);
});
