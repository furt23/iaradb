import { test } from "node:test";
import assert from "node:assert/strict";
import { col, fromColumns, fromRecords, type DataFrame } from "./index.js";

test("every plain value type survives fromRecords and toRecords", async () => {
  const when = new Date("2024-01-02T03:04:05.678Z");
  const bytes = new Uint8Array([0, 1, 255]);
  const df = await fromRecords([
    { i: 1, big: 2n ** 62n, f: 1.5, b: true, s: "x", d: when, bytes, nothing: null },
    { i: -2, big: 5, f: -0.25, b: false, s: "", d: null, bytes: null, nothing: null },
  ]);
  const rows = await df.toRecords();
  assert.deepEqual(rows[0], { i: 1, big: 2n ** 62n, f: 1.5, b: true, s: "x", d: when, bytes, nothing: null });
  assert.deepEqual(rows[1], { i: -2, big: 5, f: -0.25, b: false, s: "", d: null, bytes: null, nothing: null });
  assert.ok(rows[0].d instanceof Date);
  assert.ok(rows[0].bytes instanceof Uint8Array);
  assert.equal(typeof rows[1].big, "number");
  assert.equal(typeof rows[0].big, "bigint");
});

test("integers come back as numbers when safe, as bigints beyond", async () => {
  const df = await fromRecords([{ v: Number.MAX_SAFE_INTEGER }, { v: 2n ** 53n + 1n }]);
  assert.deepEqual(await df.toColumns(), { v: [Number.MAX_SAFE_INTEGER, 2n ** 53n + 1n] });
  assert.equal(df.schema.v, "Int64");
});

test("decimals keep their scale, sign and leading zeros", async () => {
  const df = await fromRecords([{ v: 0.05 }, { v: -0.05 }, { v: 12.5 }, { v: -100.25 }, { v: 7 }]);
  const cast = await df.select(col("v").cast("decimal(10,2)").alias("d"));
  assert.deepEqual((await cast.toColumns()).d, ["0.05", "-0.05", "12.50", "-100.25", "7.00"]);
  const whole = await df.select(col("v").cast("decimal(10,0)").alias("d"));
  assert.deepEqual((await whole.toColumns()).d, ["0", "0", "13", "-100", "7"]);
});

test("nested lists and structs come back as arrays and objects", async () => {
  const df = await fromRecords([
    { l: [1, 2], s: { x: 1, t: ["a"] }, ll: [[1], [2, 3]] },
    { l: null, s: null, ll: [] },
    { l: [], s: { x: null, t: [] }, ll: [[null]] },
  ]);
  assert.deepEqual(await df.toRecords(), [
    { l: [1, 2], s: { x: 1, t: ["a"] }, ll: [[1], [2, 3]] },
    { l: null, s: null, ll: [] },
    { l: [], s: { x: null, t: [] }, ll: [[null]] },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(await df.toRecords()))[0].ll, [[1], [2, 3]]);
});

test("missing keys are null and columns are the keys of all rows in first-seen order", async () => {
  const df = await fromRecords([{ a: 1 }, { b: "x", a: 2 }, { c: true }]);
  assert.deepEqual(df.columns, ["a", "b", "c"]);
  assert.deepEqual(await df.toRecords(), [
    { a: 1, b: null, c: null },
    { a: 2, b: "x", c: null },
    { a: null, b: null, c: true },
  ]);
});

test("a column of only nulls keeps its rows", async () => {
  const df = await fromRecords([{ x: null }, { x: null }]);
  assert.deepEqual(await df.toRecords(), [{ x: null }, { x: null }]);
});

test("floats and integers mixed in one column are floats", async () => {
  const df = await fromRecords([{ v: 1 }, { v: 2.5 }]);
  assert.equal(df.schema.v, "Float64");
  assert.deepEqual((await df.toColumns()).v, [1, 2.5]);
});

test("dates keep their milliseconds", async () => {
  const when = new Date("2024-02-29T23:59:59.999Z");
  const df = await fromColumns({ d: [when] });
  assert.equal(((await df.toColumns()).d[0] as Date).getTime(), when.getTime());
});

test("an empty input gives an empty frame", async () => {
  const none = await fromRecords([]);
  assert.deepEqual(none.shape, [0, 0]);
  assert.deepEqual(await none.toRecords(), []);
  assert.deepEqual(await none.toColumns(), {});
  const cols = await fromColumns({});
  assert.deepEqual(cols.shape, [0, 0]);
});

test("fromColumns builds typed columns and checks the lengths", async () => {
  const df = await fromColumns({ a: [1, 2], b: ["x", "y"] });
  assert.deepEqual(await df.toColumns(), { a: [1, 2], b: ["x", "y"] });
  await assert.rejects(fromColumns({ a: [1, 2], b: ["x"] }), /same number of values/);
  await assert.rejects(fromColumns({ a: 1 as unknown as unknown[] }), /must be an array/);
});

test("mixed incompatible types throw a clear error naming the column", async () => {
  await assert.rejects(fromRecords([{ x: 1 }, { x: "a" }]), /column "x" mixes number and string values/);
  await assert.rejects(fromColumns({ x: [1n, 1.5] }), /column "x" mixes integers and non-integer numbers/);
  await assert.rejects(fromRecords([{ x: { a: 1 } }, { x: [1] }]), /column "x" mixes object and list values/);
  await assert.rejects(fromRecords([{ x: new Date(Number.NaN) }]), /invalid Date/);
  await assert.rejects(fromRecords([1 as unknown as Record<string, unknown>]), /plain objects/);
});

test("rows, item and format read a frame", async () => {
  const df: DataFrame = await fromColumns({ a: [1, 2], b: ["x", "y"] });
  assert.deepEqual(await df.rows(), [
    [1, "x"],
    [2, "y"],
  ]);
  const one = await fromColumns({ v: [42] });
  assert.equal(await one.item(), 42);
  await assert.rejects(df.item(), /item\(\) requires a 1x1 frame, got shape \(2, 2\)/);
  const text = await df.format(5);
  assert.match(text, /a/);
  assert.match(text, /y/);
});
