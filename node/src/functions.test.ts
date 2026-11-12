import { test } from "node:test";
import assert from "node:assert/strict";
import type { Expr } from "./index.js";
import {
  all,
  coalesce,
  col,
  concatList,
  concatStr,
  count,
  countIf,
  fromColumns,
  greatest,
  least,
  len,
  lit,
  max,
  mean,
  min,
  now,
  pi,
  rand,
  sum,
  when,
} from "./index.js";
import { sampleFrame, valuesOf } from "./testutil.js";

test("col, all and lit", async () => {
  const df = await sampleFrame();
  const [a, b] = col("a", "b");
  assert.deepEqual(await valuesOf(df, a.plus(b)), [11, 22, 33, 44, null]);
  const everything = await df.select(all());
  assert.deepEqual(everything.columns, ["a", "b", "s", "f", "g"]);
  assert.deepEqual(await valuesOf(df, lit(7)), [7, 7, 7, 7, 7]);
  assert.deepEqual(await valuesOf(df, lit("x")), ["x", "x", "x", "x", "x"]);
  assert.deepEqual(await valuesOf(df, lit(true)), [true, true, true, true, true]);
  assert.deepEqual(await valuesOf(df, lit(2n ** 62n)), [4611686018427387904n, 4611686018427387904n, 4611686018427387904n, 4611686018427387904n, 4611686018427387904n]);
  assert.deepEqual(await valuesOf(df, lit({ k: 1, t: "a" })), [{ k: 1, t: "a" }, { k: 1, t: "a" }, { k: 1, t: "a" }, { k: 1, t: "a" }, { k: 1, t: "a" }]);
});

test("when / then / otherwise chains", async () => {
  const df = await sampleFrame();
  const chain = when(col("a").gt(2)).then("big").when(col("a").gt(1)).then("mid").otherwise("small");
  assert.deepEqual(await valuesOf(df, chain), ["small", "mid", "big", "big", "small"]);
  assert.deepEqual(await valuesOf(df, when(col("a").gt(2)).then(1)), [null, null, 1, 1, null]);
});

test("aggregate functions, counting and their column forms", async () => {
  const df = await sampleFrame();
  const scalar = async (e: Expr) => (await df.lazy().agg(e.alias("r")).collect()).toColumns().then((c) => c.r[0]);
  assert.equal(await scalar(count()), 5);
  assert.equal(await scalar(len()), 5);
  assert.equal(await scalar(countIf(col("a").gt(1))), 3);
  assert.equal(await scalar(countIf(col("a").gt(100))), 0);
  assert.equal(await scalar(sum("b")), 150);
  assert.equal(await scalar(mean("b")), 30);
  assert.equal(await scalar(min("b")), 10);
  assert.equal(await scalar(max("b")), 50);
});

test("coalesce, greatest, least, and the list and string concatenations", async () => {
  const df = await sampleFrame();
  assert.deepEqual(await valuesOf(df, coalesce("a", "b")), [1, 2, 3, 4, 50]);
  assert.deepEqual(await valuesOf(df, greatest("a", "b")), [10, 20, 30, 40, 50]);
  assert.deepEqual(await valuesOf(df, least("a", "b")), [1, 2, 3, 4, 50]);
  const lists = await fromColumns({ l1: [[1], [2]], l2: [[3], [4]] });
  assert.deepEqual(await valuesOf(lists, concatList("l1", "l2")), [[1, 3], [2, 4]]);
  assert.deepEqual((await valuesOf(df, concatStr(["s", "g"], { separator: "-" }))).slice(0, 2), ["apple-x", "banana-y"]);
  assert.deepEqual((await valuesOf(df, concatStr(["s", "g"]))).slice(0, 2), ["applex", "bananay"]);
});

test("now, pi and rand", async () => {
  const df = await sampleFrame();
  const stamp = (await valuesOf(df, now()))[0] as Date;
  assert.ok(stamp instanceof Date);
  assert.ok(Math.abs(stamp.getTime() - Date.now()) < 60_000);
  assert.ok(Math.abs(((await valuesOf(df, pi()))[0] as number) - Math.PI) < 1e-12);
  // a seed makes the draws reproducible, and with a key a pure function of (seed, key)
  const seeded = await valuesOf(df, rand({ seed: 1 }));
  assert.deepEqual(await valuesOf(df, rand({ seed: 1 })), seeded);
  const keyed = await valuesOf(df, rand({ seed: 7, key: col("b") }));
  assert.deepEqual(await valuesOf(df, rand({ seed: 7, key: col("b") })), keyed);
  for (const v of [...seeded, ...keyed] as number[]) assert.ok(v >= 0 && v < 1);
  const free = (await valuesOf(df, rand())) as number[];
  assert.ok(free.every((v) => v >= 0 && v < 1));
  assert.throws(() => rand({ key: 1 }), /`key` needs a `seed`/);
});
