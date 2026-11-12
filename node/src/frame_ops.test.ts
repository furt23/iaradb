import { test } from "node:test";
import assert from "node:assert/strict";
import { concat, fromColumns, type DataFrame } from "./index.js";
import { sampleFrame } from "./testutil.js";

const gaps = () => fromColumns({ x: [1, null, null, 4, null] });

test("fillNull with a value", async () => {
  const df = await sampleFrame();
  const out = await df.lazy().fillNull({ value: 0, subset: ["a"] }).collect();
  assert.deepEqual((await out.toColumns()).a, [1, 2, 3, 4, 0]);
  assert.throws(() => df.lazy().fillNull({}), /pass exactly one of/);
  assert.throws(() => df.lazy().fillNull({ value: 1, strategy: "zero" }), /pass exactly one of/);
});

test("fillNull with each strategy", async () => {
  const df = await gaps();
  const fill = async (strategy: "forward" | "backward" | "min" | "max" | "mean" | "zero" | "one") =>
    (await (await df.lazy().fillNull({ strategy }).collect()).toColumns()).x;
  assert.deepEqual(await fill("forward"), [1, 1, 1, 4, 4]);
  assert.deepEqual(await fill("backward"), [1, 4, 4, 4, null]);
  assert.deepEqual(await fill("min"), [1, 1, 1, 4, 1]);
  assert.deepEqual(await fill("max"), [1, 4, 4, 4, 4]);
  assert.deepEqual(await fill("mean"), [1, 2.5, 2.5, 4, 2.5]);
  assert.deepEqual(await fill("zero"), [1, 0, 0, 4, 0]);
  assert.deepEqual(await fill("one"), [1, 1, 1, 4, 1]);
});

test("fillNan replaces NaN in float columns, nulls stay", async () => {
  const df = await fromColumns({ f: [Number.NaN, 1, null] });
  assert.deepEqual((await (await df.fillNan(0)).toColumns()).f, [0, 1, null]);
  assert.deepEqual((await (await df.lazy().fillNan(9, ["f"]).collect()).toColumns()).f, [9, 1, null]);
  const noFloats = await fromColumns({ n: [1, 2] });
  assert.equal((await noFloats.lazy().fillNan(0).collect()).height, 2);
  await assert.rejects(Promise.resolve().then(() => df.lazy().fillNan(0, ["nope"])), /unknown columns/);
});

test("dropNulls and dropNans", async () => {
  const df = await sampleFrame();
  assert.equal((await df.lazy().dropNulls().collect()).height, 2);
  assert.equal((await df.lazy().dropNulls("a").collect()).height, 4);
  const nan = await fromColumns({ f: [Number.NaN, 1, null] });
  assert.deepEqual((await (await nan.lazy().dropNans().collect()).toColumns()).f, [1, null]);
  assert.throws(() => df.lazy().dropNans("s"), /NaN handling needs float columns/);
});

test("unique keeps the first, last or no duplicate", async () => {
  const df = await fromColumns({ k: [1, 1, 2, 3, 3, 3], v: ["a", "b", "c", "d", "e", "f"] });
  const values = async (keep: "any" | "first" | "last" | "none") =>
    ((await (await df.lazy().unique({ subset: "k", keep, maintainOrder: true }).collect()).toColumns()).v as string[]);
  assert.deepEqual(await values("first"), ["a", "c", "d"]);
  assert.deepEqual(await values("last"), ["b", "c", "f"]);
  assert.deepEqual(await values("none"), ["c"]);
  assert.equal((await values("any")).length, 3);
  assert.equal((await df.lazy().unique({ subset: "k" }).collect()).height, 3);
  assert.throws(() => df.lazy().unique({ keep: "bogus" as "any" }), /keep must be one of/);
});

test("sample takes exactly n rows, or a fraction of them, reproducibly", async () => {
  const df = await fromColumns({ i: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
  const two = await df.sample({ n: 2, seed: 42 });
  assert.equal(two.height, 2);
  assert.deepEqual((await two.toColumns()).i, (await (await df.sample({ n: 2, seed: 42 })).toColumns()).i);
  assert.equal((await df.sample({ fraction: 0.4, seed: 1 })).height, 4);
  assert.equal((await df.sample({ n: 15, withReplacement: true, seed: 3 })).height, 15);
  await assert.rejects(df.sample({ n: 11, seed: 1 }), /cannot take 11 rows without replacement from 10/);
  await assert.rejects(df.sample({ seed: 1 }), /pass exactly one of/);
  await assert.rejects(df.sample({ n: 1, fraction: 0.5 }), /pass exactly one of/);
});

test("withRowIndex adds the first column, from an offset", async () => {
  const df = await sampleFrame();
  const out = await df.lazy().withRowIndex({ name: "idx", offset: 10 }).collect();
  assert.deepEqual(out.columns.slice(0, 2), ["idx", "a"]);
  assert.deepEqual((await out.toColumns()).idx, [10, 11, 12, 13, 14]);
  const plain = await df.lazy().withRowIndex().collect();
  assert.deepEqual((await plain.toColumns()).index, [0, 1, 2, 3, 4]);
  assert.throws(() => df.lazy().withRowIndex({ name: "a" }), /already exists/);
});

test("concat stacks vertically, checking the columns, and diagonally, aligning them", async () => {
  const a = await fromColumns({ x: [1, 2], s: ["p", "q"] });
  const b = await fromColumns({ x: [3], s: ["r"] });
  const stacked = await concat([a.lazy(), b.lazy()]).collect();
  assert.deepEqual((await stacked.toColumns()).x, [1, 2, 3]);
  const frames = await concat([a, b]);
  assert.equal((frames as DataFrame).height, 3);
  const other = await fromColumns({ y: [9] });
  assert.throws(() => concat([a.lazy(), other.lazy()]), /same columns; use how: 'diagonal'/);
  const diagonal = await concat([a.lazy(), other.lazy()], { how: "diagonal" }).collect();
  assert.deepEqual(diagonal.columns, ["x", "s", "y"]);
  assert.deepEqual(await diagonal.toRecords(), [
    { x: 1, s: "p", y: null },
    { x: 2, s: "q", y: null },
    { x: null, s: null, y: 9 },
  ]);
  const ints = await fromColumns({ n: [1, 2] });
  const floats = await fromColumns({ n: [0.5] });
  const unified = await concat([ints, floats], { how: "diagonal" });
  assert.equal(unified.schema.n, "Float64");
  assert.throws(() => concat([] as DataFrame[]), /needs at least one frame/);
  assert.throws(() => concat([a.lazy()], { how: "sideways" as "vertical" }), /how must be/);
});

test("unionByName matches columns by name", async () => {
  const a = await fromColumns({ x: [1], y: ["a"] });
  const b = await fromColumns({ y: ["b"], z: [true] });
  const out = await a.lazy().unionByName(b).collect();
  assert.deepEqual(out.columns, ["x", "y", "z"]);
  assert.equal(out.height, 2);
});

test("describe gives the statistics as text, per column", async () => {
  const df = await fromColumns({ a: [1, 2, 3, null], s: ["x", "y", "z", "w"] });
  const stats = await df.describe();
  assert.deepEqual((await stats.toColumns()).statistic, ["count", "null_count", "mean", "std", "min", "25%", "50%", "75%", "max"]);
  const cols = await stats.toColumns();
  assert.deepEqual(cols.a.slice(0, 2), ["3", "1"]);
  assert.deepEqual(cols.a.slice(4), ["1", "1.5", "2", "2.5", "3"]);
  assert.deepEqual(cols.s.slice(0, 2), ["4", "0"]);
  assert.equal(cols.s[2], null);
  assert.equal(cols.s[4], "w");
  assert.equal(cols.s[8], "z");
  assert.deepEqual((await (await df.summary()).toColumns()).statistic, cols.statistic);
});
