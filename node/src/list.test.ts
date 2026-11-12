import { test } from "node:test";
import assert from "node:assert/strict";
import { col, fromColumns, type DataFrame } from "./index.js";
import { valuesOf } from "./testutil.js";

/** Lists: [3,1,2], [], null, [4,null], [5,5]; index column i picks an element. */
function lists(): Promise<DataFrame> {
  return fromColumns({
    l: [[3, 1, 2], [], null, [4, null], [5, 5]],
    i: [0, 0, 0, 1, -1],
  });
}

const l = () => col("l").list;

test("size and element access", async () => {
  const df = await lists();
  assert.deepEqual(await valuesOf(df, l().len()), [3, 0, null, 2, 2]);
  assert.deepEqual(await valuesOf(df, l().get(0)), [3, null, null, 4, 5]);
  assert.deepEqual(await valuesOf(df, l().get(-1)), [2, null, null, null, 5]);
  assert.deepEqual(await valuesOf(df, l().get(col("i"))), [3, null, null, null, 5]);
  assert.deepEqual(await valuesOf(df, l().get(9)), [null, null, null, null, null]);
  assert.deepEqual(await valuesOf(df, l().first()), [3, null, null, 4, 5]);
  assert.deepEqual(await valuesOf(df, l().last()), [2, null, null, null, 5]);
});

test("slicing, head, tail and contains", async () => {
  const df = await lists();
  assert.deepEqual(await valuesOf(df, l().slice(1, 2)), [[1, 2], [], null, [null], [5]]);
  assert.deepEqual(await valuesOf(df, l().slice(-2)), [[1, 2], [], null, [4, null], [5, 5]]);
  assert.deepEqual(await valuesOf(df, l().head(2)), [[3, 1], [], null, [4, null], [5, 5]]);
  assert.deepEqual(await valuesOf(df, l().tail(2)), [[1, 2], [], null, [4, null], [5, 5]]);
  assert.deepEqual(await valuesOf(df, l().contains(2)), [true, false, null, false, false]);
});

test("ordering and reshaping", async () => {
  const df = await lists();
  // nulls sort first unless nullsLast is set
  assert.deepEqual(await valuesOf(df, l().sort()), [[1, 2, 3], [], null, [null, 4], [5, 5]]);
  assert.deepEqual(await valuesOf(df, l().sort({ descending: true })), [[3, 2, 1], [], null, [null, 4], [5, 5]]);
  assert.deepEqual(await valuesOf(df, l().sort({ nullsLast: true })), [[1, 2, 3], [], null, [4, null], [5, 5]]);
  assert.deepEqual(await valuesOf(df, l().reverse()), [[2, 1, 3], [], null, [null, 4], [5, 5]]);
  assert.deepEqual(await valuesOf(df, l().nUnique()), [3, 0, null, 2, 1]);
  // the order of distinct elements is not guaranteed, so compare their lengths
  assert.deepEqual(await valuesOf(df, l().unique().list.len()), [3, 0, null, 2, 1]);
});

test("reductions ignore nulls and give null for a null list", async () => {
  const df = await lists();
  assert.deepEqual(await valuesOf(df, l().sum()), [6, 0, null, 4, 10]);
  assert.deepEqual(await valuesOf(df, l().min()), [1, null, null, 4, 5]);
  assert.deepEqual(await valuesOf(df, l().max()), [3, null, null, 4, 5]);
  assert.deepEqual(await valuesOf(df, l().mean()), [2, null, null, 4, 5]);
  assert.deepEqual(await valuesOf(df, l().median()), [2, null, null, 4, 5]);
});

test("joining the elements as text", async () => {
  const df = await lists();
  assert.deepEqual(await valuesOf(df, l().join(",")), ["3,1,2", "", null, "4", "5,5"]);
  const kept = await valuesOf(df, l().join(",", { ignoreNulls: false }));
  assert.equal(kept[3], null);
  assert.equal(kept[0], "3,1,2");
});
