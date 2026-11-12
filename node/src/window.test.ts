import { test } from "node:test";
import assert from "node:assert/strict";
import { col, rowNumber } from "./index.js";
import { sampleFrame, valuesOf } from "./testutil.js";

test("over: partitions and frames", async () => {
  const df = await sampleFrame();
  // b is 10..50; g groups rows x, y, x, y, x
  assert.deepEqual(await valuesOf(df, col("b").sum().over()), [150, 150, 150, 150, 150]);
  assert.deepEqual(await valuesOf(df, col("b").sum().over("g")), [90, 60, 90, 60, 90]);
  assert.deepEqual(await valuesOf(df, col("b").sum().over(["g"])), [90, 60, 90, 60, 90]);
  assert.deepEqual(
    await valuesOf(df, col("b").sum().over(undefined, { orderBy: "b", frame: { units: "rows", start: -1, end: 0 } })),
    [10, 30, 50, 70, 90],
  );
  assert.deepEqual(
    await valuesOf(df, col("b").sum().over(null, { orderBy: "b", descending: true, frame: { units: "rows", start: null, end: 0 } })),
    [150, 140, 120, 90, 50],
  );
  // demeaned per group: each row minus its group's mean (both groups average 30)
  assert.deepEqual(await valuesOf(df, (col("b").minus(col("b").mean())).over("g")), [-20, -10, 0, 10, 20]);
});

test("rank: methods, direction and nulls", async () => {
  const df = await sampleFrame();
  assert.deepEqual(await valuesOf(df, col("b").rank("ordinal")), [1, 2, 3, 4, 5]);
  assert.deepEqual(await valuesOf(df, col("b").rank("min", { descending: true })), [5, 4, 3, 2, 1]);
  assert.deepEqual(await valuesOf(df, col("g").rank("dense")), [1, 2, 1, 2, 1]);
  assert.deepEqual(await valuesOf(df, col("g").rank("min")), [1, 4, 1, 4, 1]);
  assert.deepEqual(await valuesOf(df, col("g").rank()), [2, 4.5, 2, 4.5, 2]);
  assert.deepEqual(await valuesOf(df, col("a").rank("dense")), [1, 2, 3, 4, null]);
  assert.throws(() => col("b").rank("nope" as "min"), /unknown rank method/);
});

test("row_number", async () => {
  const df = await sampleFrame();
  assert.deepEqual(await valuesOf(df, rowNumber()), [1, 2, 3, 4, 5]);
  assert.deepEqual(await valuesOf(df, rowNumber().over("g")), [1, 1, 2, 2, 3]);
});

test("shift and diff", async () => {
  const df = await sampleFrame();
  assert.deepEqual(await valuesOf(df, col("b").shift()), [null, 10, 20, 30, 40]);
  assert.deepEqual(await valuesOf(df, col("b").shift(1, 0)), [0, 10, 20, 30, 40]);
  assert.deepEqual(await valuesOf(df, col("b").shift(-1)), [20, 30, 40, 50, null]);
  assert.deepEqual(await valuesOf(df, col("b").diff()), [null, 10, 10, 10, 10]);
  assert.deepEqual(await valuesOf(df, col("b").diff(2)), [null, null, 20, 20, 20]);
});

test("cumulative aggregates", async () => {
  const df = await sampleFrame();
  assert.deepEqual(await valuesOf(df, col("b").cumSum()), [10, 30, 60, 100, 150]);
  assert.deepEqual(await valuesOf(df, col("b").cumSum({ reverse: true })), [150, 140, 120, 90, 50]);
  assert.deepEqual(await valuesOf(df, col("b").cumMin()), [10, 10, 10, 10, 10]);
  assert.deepEqual(await valuesOf(df, col("b").cumMax()), [10, 20, 30, 40, 50]);
  // a null keeps its place as null; cumCount counts the non-null values so far
  assert.deepEqual(await valuesOf(df, col("a").cumSum()), [1, 3, 6, 10, null]);
  assert.deepEqual(await valuesOf(df, col("a").cumCount()), [1, 2, 3, 4, 4]);
});

test("rolling aggregates", async () => {
  const df = await sampleFrame();
  assert.deepEqual(await valuesOf(df, col("b").rollingSum(2)), [null, 30, 50, 70, 90]);
  assert.deepEqual(await valuesOf(df, col("b").rollingSum(3, { center: true })), [null, 60, 90, 120, null]);
  assert.deepEqual(await valuesOf(df, col("b").rollingMean(3, { minPeriods: 1 })), [10, 15, 20, 30, 40]);
  assert.deepEqual(await valuesOf(df, col("b").rollingMin(2)), [null, 10, 20, 30, 40]);
  assert.deepEqual(await valuesOf(df, col("b").rollingMax(2)), [null, 20, 30, 40, 50]);
  assert.deepEqual(await valuesOf(df, col("b").rollingStd(3, { minPeriods: 3 })), [null, null, 10, 10, 10]);
  assert.deepEqual(await valuesOf(df, col("b").rollingVar(3, { minPeriods: 3 })), [null, null, 100, 100, 100]);
  const population = (await valuesOf(df, col("b").rollingVar(3, { minPeriods: 3, ddof: 0 }))) as Array<number | null>;
  assert.equal(population[0], null);
  assert.equal(population[1], null);
  for (const v of population.slice(2)) assert.ok(v !== null && Math.abs(v - 200 / 3) < 1e-9);
  assert.throws(() => col("b").rollingSum(0), /window_size must be at least 1/);
});
