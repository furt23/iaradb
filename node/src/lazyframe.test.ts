import { test } from "node:test";
import assert from "node:assert/strict";
import { col, fromColumns, lit, sql, type DataFrame, type JoinOptions, type LazyFrame } from "./index.js";
import { readParquet } from "./io.js";
import { sampleFrame, tempDir, valuesOf } from "./testutil.js";

test("filter combines predicates, and an empty filter keeps everything", async () => {
  const df = await sampleFrame();
  const out = await df.lazy().filter(col("a").gt(1), col("b").lt(40)).collect();
  assert.deepEqual((await out.toColumns()).a, [2, 3]);
  assert.equal((await df.lazy().filter().collect()).height, 5);
  assert.equal((await df.lazy().where(col("a").eq(4)).collect()).height, 1);
});

test("select takes names, expressions and named entries; an unnamed expression keeps its column", async () => {
  const df = await sampleFrame();
  const out = await df.lazy().select("a", col("b").plus(1).alias("b1"), { c: col("b").mul(2) }).collect();
  assert.deepEqual(out.columns, ["a", "b1", "c"]);
  assert.deepEqual((await out.toColumns()).c, [20, 40, 60, 80, 100]);
  const unnamed = await df.lazy().select(col("a").plus(1)).collect();
  assert.deepEqual(unnamed.columns, ["a"]);
});

test("withColumns replaces by name and adds new ones", async () => {
  const df = await sampleFrame();
  const out = await df.lazy().withColumns({ a: col("a").mul(10), z: lit(1) }).collect();
  assert.deepEqual(out.columns, ["a", "b", "s", "f", "g", "z"]);
  assert.deepEqual((await out.toColumns()).a, [10, 20, 30, 40, null]);
});

test("group by with aggregates, counts and sums of every other column", async () => {
  const df = await fromColumns({ g: ["x", "y", "x", "y", "x"], v: [1, 2, 3, 4, 5], w: [10, 20, 30, 40, 50] });
  const grouped = await df.lazy().groupBy("g").agg(col("v").sum().alias("total")).sort("g").collect();
  assert.deepEqual(await grouped.toRecords(), [
    { g: "x", total: 9 },
    { g: "y", total: 6 },
  ]);
  const counts = await df.lazy().groupBy("g").count().sort("g").collect();
  assert.deepEqual((await counts.toColumns()).count, [3, 2]);
  const lens = await df.lazy().groupBy("g").len().sort("g").collect();
  assert.deepEqual(lens.columns, ["g", "len"]);
  const sums = await df.lazy().groupBy("g").sum().sort("g").collect();
  assert.deepEqual(sums.columns, ["g", "v", "w"]);
  assert.deepEqual((await sums.toColumns()).w, [90, 60]);
  const means = await df.lazy().groupBy("g").mean().sort("g").collect();
  assert.deepEqual((await means.toColumns()).v, [3, 3]);
  const mins = await df.lazy().groupBy("g").min().sort("g").collect();
  assert.deepEqual((await mins.toColumns()).v, [1, 2]);
  const maxs = await df.lazy().groupBy("g").max().sort("g").collect();
  assert.deepEqual((await maxs.toColumns()).w, [50, 40]);
});

test("a global aggregate is one row", async () => {
  const df = await sampleFrame();
  const out = await df.lazy().agg(col("b").sum().alias("t"), col("a").max()).collect();
  assert.deepEqual(await out.toRecords(), [{ t: 150, a: 4 }]);
});

test("every join kind", async () => {
  const left = await fromColumns({ k: [1, 2, 3], x: ["a", "b", "c"] });
  const right = await fromColumns({ k: [2, 3, 4], y: ["B", "C", "D"] });
  const joined = async (options: JoinOptions) => (await left.lazy().join(right.lazy(), options).collect()).toColumns();
  const sorted = (values: unknown[]) => [...values].sort((p, q) => String(p).localeCompare(String(q)));
  const inner = await joined({ on: "k" });
  assert.deepEqual(sorted(inner.x), ["b", "c"]);
  assert.deepEqual(sorted(inner.y), ["B", "C"]);
  assert.equal((await joined({ on: "k", how: "left" })).x.length, 3);
  // the key comes from the left side, so an unmatched right row has a null key
  const rightOnly = await joined({ on: "k", how: "right" });
  assert.equal(rightOnly.y.length, 3);
  assert.ok(rightOnly.y.includes("D"));
  assert.equal(rightOnly.k.filter((v) => v === null).length, 1);
  const full = await joined({ on: "k", how: "full" });
  assert.equal(full.x.length, 4);
  assert.ok(full.x.includes("a"));
  assert.deepEqual(sorted((await joined({ on: "k", how: "semi" })).x), ["b", "c"]);
  assert.deepEqual((await joined({ on: "k", how: "anti" })).x, ["a"]);
  const cross = await left.lazy().join(right, { how: "cross" }).collect();
  assert.equal(cross.height, 9);
});

test("join on different key names: the right key is dropped, a clash gets a suffix", async () => {
  const left = await fromColumns({ id: [1, 2], v: ["l1", "l2"] });
  const right = await fromColumns({ key: [2, 1], v: ["r2", "r1"] });
  const out = await left.lazy().join(right, { leftOn: "id", rightOn: "key" }).sort("id").collect();
  assert.deepEqual(out.columns, ["id", "v", "v_right"]);
  assert.deepEqual(await out.toRecords(), [
    { id: 1, v: "l1", v_right: "r1" },
    { id: 2, v: "l2", v_right: "r2" },
  ]);
  const suffixed = await left.lazy().join(right, { leftOn: "id", rightOn: "key", suffix: "_r" }).collect();
  assert.ok(suffixed.columns.includes("v_r"));
  assert.throws(() => left.lazy().join(right, { leftOn: "id" }), /requires `on` or both/);
});

test("sort places nulls first by default and last with nullsLast", async () => {
  const df = await sampleFrame();
  const asc = await df.lazy().sort("a").collect();
  assert.deepEqual((await asc.toColumns()).a, [null, 1, 2, 3, 4]);
  const last = await df.lazy().sort("a", { nullsLast: true }).collect();
  assert.deepEqual((await last.toColumns()).a, [1, 2, 3, 4, null]);
  const desc = await df.lazy().sort("a", { descending: true }).collect();
  assert.deepEqual((await desc.toColumns()).a, [null, 4, 3, 2, 1]);
});

test("sort by several keys with a direction for each", async () => {
  const df = await sampleFrame();
  const out = await df.lazy().sort(["g", "b"], { descending: [false, true] }).collect();
  assert.deepEqual((await out.toColumns()).b, [50, 30, 10, 40, 20]);
});

test("limit, head, slice and fetch", async () => {
  const df = await sampleFrame();
  assert.equal((await df.lazy().limit(2).collect()).height, 2);
  assert.equal((await df.lazy().head().collect()).height, 5);
  const sliced = await df.lazy().slice(1, 2).collect();
  assert.deepEqual((await sliced.toColumns()).a, [2, 3]);
});

test("unique, drop, rename and union", async () => {
  const df = await fromColumns({ a: [1, 1, 2], b: ["x", "x", "y"] });
  assert.equal((await df.lazy().unique().collect()).height, 2);
  assert.equal((await df.lazy().distinct().collect()).height, 2);
  const dropped = await df.lazy().drop("b").collect();
  assert.deepEqual(dropped.columns, ["a"]);
  const renamed = await df.lazy().rename({ a: "z" }).collect();
  assert.deepEqual(renamed.columns, ["z", "b"]);
  const both = await df.lazy().union(df).collect();
  assert.equal(both.height, 6);
});

test("explode lists, with an empty list as one null row", async () => {
  const df = await fromColumns({ id: [1, 2], l: [[10, 11], []] });
  const out = await df.lazy().explode("l").collect();
  assert.deepEqual(await out.toRecords(), [
    { id: 1, l: 10 },
    { id: 1, l: 11 },
    { id: 2, l: null },
  ]);
});

test("unnest a struct into one column per field, with an optional separator", async () => {
  const df = await fromColumns({ s: [{ x: 1, y: "a" }] });
  const plain = await df.lazy().select(col("s").struct.unnest()).collect();
  assert.deepEqual(await plain.toRecords(), [{ x: 1, y: "a" }]);
  const separated = await df.lazy().unnest("s", { separator: "_" }).collect();
  assert.deepEqual(separated.columns, ["s_x", "s_y"]);
  assert.throws(() => df.lazy().agg(col("s").struct.unnest()), /only valid in select and withColumns/);
});

test("sql on a frame, with positional and named parameters", async () => {
  const df = await sampleFrame();
  const positional = await (await df.lazy().sql("select a from self where a > $1 order by a", { params: [2] })).collect();
  assert.deepEqual((await positional.toColumns()).a, [3, 4]);
  const named = await (await df.lazy().sql("select a from t where a < :hi order by a", { tableName: "t", params: { hi: 3 } })).collect();
  assert.deepEqual((await named.toColumns()).a, [1, 2]);
});

test("top-level sql over named frames", async () => {
  const df = await sampleFrame();
  const out = await (await sql("select sum(b) as total from t where a >= ?", { params: [2], tables: { t: df } })).collect();
  // a >= 2 keeps b = 20, 30 and 40
  assert.deepEqual(await out.toRecords(), [{ total: 90 }]);
});

test("explain returns the plan as text", async () => {
  const df = await sampleFrame();
  const plan = await df.lazy().filter(col("a").gt(1)).explain();
  assert.equal(typeof plan, "string");
  assert.ok(plan.length > 0);
  assert.equal(typeof (await df.lazy().explain(false)), "string");
});

test("a failing query rejects with the engine's error code", async () => {
  await assert.rejects(sql("select * from no_such_table"), (err: { code?: string }) => err.code === "IaraError");
  // a missing column is found while the plan is built, so select itself throws
  const df = await sampleFrame();
  assert.throws(() => df.lazy().select(col("missing")), (err: { code?: string }) => err.code === "IaraError");
});

test("stream reads the result batch by batch, and iterBatches stops early on break", async () => {
  const df = await sampleFrame();
  const stream = await df.lazy().stream();
  assert.deepEqual(Object.keys(stream.schema), ["a", "b", "s", "f", "g"]);
  let rows = 0;
  for await (const batch of stream) rows += batch.numRows;
  assert.equal(rows, 5);
  let seen = 0;
  for await (const batch of df.lazy().iterBatches()) {
    seen += batch.numRows;
    break;
  }
  assert.ok(seen > 0);
});

test("lazy() and the metadata getters", async () => {
  const df = await sampleFrame();
  const lf: LazyFrame = df.lazy();
  assert.strictEqual(lf.lazy(), lf);
  assert.deepEqual(lf.columns, ["a", "b", "s", "f", "g"]);
  assert.equal(lf.schema.b, "Int64");
});

test("sinks write Parquet, CSV and NDJSON and report the rows written", async () => {
  const tmp = await tempDir();
  try {
    const df = await sampleFrame();
    assert.equal(await df.lazy().sinkParquet(tmp.file("out.parquet")), 5);
    assert.equal(await df.lazy().sinkCsv(tmp.file("out.csv")), 5);
    assert.equal(await df.lazy().sinkNdjson(tmp.file("out.ndjson")), 5);
    const back = await readParquet(tmp.file("out.parquet"));
    assert.deepEqual(await back.toColumns(), await df.toColumns());
  } finally {
    await tmp.cleanup();
  }
});

test("sinkDelta writes a table, and a schema mode other than merge is refused", async () => {
  const tmp = await tempDir();
  try {
    const df = await sampleFrame();
    const write = await df.lazy().sinkDelta(tmp.file("table"));
    assert.equal(write.rows, 5);
    const again = await df.lazy().sinkDelta(tmp.file("table"), { mode: "append" });
    assert.equal(again.rows, 5);
    await assert.rejects(df.lazy().sinkDelta(tmp.file("x"), { schemaMode: "other" as "merge" }), /schemaMode/);
  } finally {
    await tmp.cleanup();
  }
});

test("fetch returns the first rows as a DataFrame", async () => {
  const df = await sampleFrame();
  const first: DataFrame = await df.lazy().fetch(2);
  assert.deepEqual((await first.toColumns()).a, [1, 2]);
  assert.deepEqual(await valuesOf(df, col("a")), [1, 2, 3, 4, null]);
});

test("sample on a lazy frame takes the rows of the seed, reproducibly", async () => {
  const df = await fromColumns({ i: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
  const first = await (await df.lazy().sample({ fraction: 0.5, seed: 11 })).collect();
  const again = await (await df.lazy().sample({ fraction: 0.5, seed: 11 })).collect();
  assert.equal(first.height, 5);
  assert.deepEqual((await first.toColumns()).i, (await again.toColumns()).i);
});
