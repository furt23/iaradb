import { test } from "node:test";
import assert from "node:assert/strict";
import { Datetime, Decimal, Float64, Int64, List, Struct, Utf8 } from "./index.js";

test("scalar type names", () => {
  assert.equal(Int64, "int64");
  assert.equal(Float64, "float64");
  assert.equal(Utf8, "utf8");
  assert.equal(Datetime, "timestamp");
});

test("Decimal, List and Struct spell the engine's type names", () => {
  assert.equal(Decimal(), "decimal(38,9)");
  assert.equal(Decimal(10, 2), "decimal(10,2)");
  assert.equal(List(Int64), "list<int64>");
  assert.equal(List(List(Utf8)), "list<list<utf8>>");
  assert.equal(Struct({ a: Int64, "b c": Utf8 }), 'struct<a: int64, "b c": utf8>');
  assert.equal(Struct([["x", Int64]]), "struct<x: int64>");
});

test("Struct and List reject an empty or non-name type", () => {
  assert.throws(() => Struct({}), /needs at least one field/);
  assert.throws(() => List(42 as unknown as string), TypeError);
});
