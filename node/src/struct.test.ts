import { test } from "node:test";
import assert from "node:assert/strict";
import { col, fromColumns, struct, lit, type DataFrame } from "./index.js";
import { sampleFrame, valuesOf } from "./testutil.js";

/** Structs {x, y} with one null struct. */
function structs(): Promise<DataFrame> {
  return fromColumns({
    s: [{ x: 1, y: "a" }, { x: 2, y: null }, null],
  });
}

const s = () => col("s").struct;

test("field access", async () => {
  const df = await structs();
  assert.deepEqual(await valuesOf(df, s().field("x")), [1, 2, null]);
  assert.deepEqual(await valuesOf(df, s().field("y")), ["a", null, null]);
});

test("renaming, adding and encoding fields", async () => {
  const df = await structs();
  assert.deepEqual(await valuesOf(df, s().renameFields(["p", "q"])), [{ p: 1, q: "a" }, { p: 2, q: null }, null]);
  // the engine's struct_insert gives a null struct the new field over null fields (Python does the same)
  assert.deepEqual(await valuesOf(df, s().withFields({ z: lit(9) })), [
    { x: 1, y: "a", z: 9 },
    { x: 2, y: null, z: 9 },
    { x: null, y: null, z: 9 },
  ]);
  assert.deepEqual(await valuesOf(df, s().jsonEncode()), ['{"x":1,"y":"a"}', '{"x":2,"y":null}', "null"]);
  assert.throws(() => s().renameFields([]), /needs the new names/);
});

test("struct() builds a struct from expressions and named entries", async () => {
  const df = await sampleFrame();
  assert.deepEqual((await valuesOf(df, struct(col("a"), { total: col("b").plus(1) }))).slice(0, 2), [
    { a: 1, total: 11 },
    { a: 2, total: 21 },
  ]);
  assert.throws(() => struct(), /needs at least one expression/);
  assert.throws(() => struct(col("a"), col("a")), /field name 'a' twice/);
  assert.throws(() => struct(col("a"), { a: col("b") }), /field name 'a' twice/);
});

test("struct.unnest expands the fields as columns in select", async () => {
  const df = await structs();
  const out = await df.select(s().unnest());
  assert.deepEqual(out.columns, ["x", "y"]);
  assert.deepEqual((await out.toRecords()).slice(0, 2), [
    { x: 1, y: "a" },
    { x: 2, y: null },
  ]);
});
