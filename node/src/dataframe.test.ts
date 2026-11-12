import { test } from "node:test";
import assert from "node:assert/strict";
import { col, fromColumns, type DataFrame } from "./index.js";
import { sampleFrame } from "./testutil.js";

test("metadata is synchronous", async () => {
  const df = await sampleFrame();
  assert.deepEqual(df.shape, [5, 5]);
  assert.equal(df.height, 5);
  assert.equal(df.width, 5);
  assert.deepEqual(df.columns, ["a", "b", "s", "f", "g"]);
  assert.equal(df.schema.a, "Int64");
  assert.equal(df.schema.s, "Utf8");
});

test("toArrow gives an Arrow table of the same rows", async () => {
  const df = await sampleFrame();
  const table = await df.toArrow();
  assert.equal(table.numRows, 5);
  assert.deepEqual(table.schema.fields.map((f) => f.name), ["a", "b", "s", "f", "g"]);
});

test("head, slice and the 1x1 item", async () => {
  const df = await sampleFrame();
  assert.equal((await df.head(2)).height, 2);
  assert.deepEqual((await (await df.slice(1, 2)).toColumns()).a, [2, 3]);
  assert.equal(await (await fromColumns({ v: [7] })).item(), 7);
});

test("the eager operations return frames", async () => {
  const df: DataFrame = await sampleFrame();
  assert.equal((await df.filter(col("a").gt(2))).height, 2);
  assert.deepEqual((await df.select(col("a"))).columns, ["a"]);
  assert.deepEqual((await df.withColumns({ z: col("b") })).columns.slice(-1), ["z"]);
  assert.deepEqual((await (await df.sort("b", { descending: true })).toColumns()).b, [50, 40, 30, 20, 10]);
  const other = await fromColumns({ a: [1], w: ["one"] });
  assert.deepEqual((await (await df.join(other, { on: "a" })).toColumns()).w, ["one"]);
  const grouped = await df.groupBy("g").agg(col("b").sum().alias("t")).then((out) => out.sort("g"));
  assert.deepEqual((await grouped.toColumns()).t, [90, 60]);
  assert.equal((await df.unique()).height, 5);
  assert.equal((await df.fillNull({ value: 0, subset: "a" })).height, 5);
  assert.equal((await df.dropNulls()).height, 2);
  assert.deepEqual((await (await df.sql("select count(*) as n from self")).toRecords()), [{ n: 5 }]);
});

test("format and show", async () => {
  const df = await sampleFrame();
  const text = await df.format(3);
  assert.match(text, /a/);
  assert.match(text, /banana/);
  await df.show(2);
});

test("the remaining eager operations: explode, unnest, dropNans, row index, sample, unionByName", async () => {
  const lists = await fromColumns({ id: [1, 2], l: [[10, 11], []] });
  const exploded = await lists.explode("l");
  assert.deepEqual((await exploded.toRecords()).map((r) => r.l), [10, 11, null]);
  const structs = await fromColumns({ s: [{ x: 1, y: "a" }] });
  const unnested = await structs.unnest("s");
  assert.deepEqual(unnested.columns, ["x", "y"]);
  const nans = await fromColumns({ f: [Number.NaN, 2, null] });
  assert.deepEqual((await (await nans.dropNans()).toColumns()).f, [2, null]);
  const df = await sampleFrame();
  const indexed = await df.withRowIndex({ name: "row" });
  assert.deepEqual((await indexed.toColumns()).row, [0, 1, 2, 3, 4]);
  const picked = await df.sample({ n: 3, seed: 5 });
  assert.equal(picked.height, 3);
  const stacked = await df.unionByName(await fromColumns({ a: [9], z: [true] }));
  assert.equal(stacked.height, 6);
  assert.ok(stacked.columns.includes("z"));
});
