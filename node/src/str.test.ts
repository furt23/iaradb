import { test } from "node:test";
import assert from "node:assert/strict";
import { col, lit, Struct, Int64, List, Utf8 } from "./index.js";
import { sampleFrame, valuesOf } from "./testutil.js";

const s = () => col("s").str;

test("pattern matching: contains, like, startsWith, endsWith", async () => {
  const df = await sampleFrame();
  assert.deepEqual(await valuesOf(df, s().contains("an")), [false, true, null, false, false]);
  assert.deepEqual(await valuesOf(df, s().contains("an", true)), [false, true, null, false, false]);
  assert.deepEqual(await valuesOf(df, s().contains("^a.*e$")), [true, false, null, false, false]);
  assert.deepEqual(await valuesOf(df, s().like("%an%")), [false, true, null, false, false]);
  assert.deepEqual(await valuesOf(df, s().like("A%", true)), [true, false, null, false, false]);
  assert.deepEqual(await valuesOf(df, s().startsWith("ba")), [false, true, null, false, false]);
  assert.deepEqual(await valuesOf(df, s().endsWith("e")), [true, false, null, false, true]);
});

test("case, length and whitespace", async () => {
  const df = await sampleFrame();
  assert.deepEqual(await valuesOf(df, s().toUppercase()), ["APPLE", "BANANA", null, "CHERRY", "DATE"]);
  assert.deepEqual(await valuesOf(df, s().toUppercase().str.toLowercase()), ["apple", "banana", null, "cherry", "date"]);
  assert.deepEqual(await valuesOf(df, s().lenChars()), [5, 6, null, 6, 4]);
  assert.deepEqual(await valuesOf(df, s().lenBytes()), [5, 6, null, 6, 4]);
  assert.deepEqual(await valuesOf(df, lit("  hi  ").str.stripChars()), ["hi", "hi", "hi", "hi", "hi"]);
  assert.deepEqual(await valuesOf(df, lit("  hi  ").str.stripCharsStart()), ["hi  ", "hi  ", "hi  ", "hi  ", "hi  "]);
  assert.deepEqual(await valuesOf(df, lit("  hi  ").str.stripCharsEnd()), ["  hi", "  hi", "  hi", "  hi", "  hi"]);
  assert.deepEqual(await valuesOf(df, lit("hello world").str.toTitlecase()), ["Hello World", "Hello World", "Hello World", "Hello World", "Hello World"]);
  assert.deepEqual(await valuesOf(df, s().reverse()), ["elppa", "ananab", null, "yrrehc", "etad"]);
});

test("slicing, head and tail", async () => {
  const df = await sampleFrame();
  assert.deepEqual(await valuesOf(df, s().slice(1, 3)), ["ppl", "ana", null, "her", "ate"]);
  assert.deepEqual(await valuesOf(df, s().slice(2)), ["ple", "nana", null, "erry", "te"]);
  assert.deepEqual(await valuesOf(df, s().head(2)), ["ap", "ba", null, "ch", "da"]);
  assert.deepEqual(await valuesOf(df, s().tail(2)), ["le", "na", null, "ry", "te"]);
});

test("replacement, extraction and splitting", async () => {
  const df = await sampleFrame();
  assert.deepEqual(await valuesOf(df, s().replaceAll("a", "A")), ["Apple", "bAnAnA", null, "cherry", "dAte"]);
  assert.deepEqual(await valuesOf(df, lit("a.b.c").str.replaceAll(".", "!", true)), ["a!b!c", "a!b!c", "a!b!c", "a!b!c", "a!b!c"]);
  assert.deepEqual(await valuesOf(df, s().replace("a", "A")), ["Apple", "bAnana", null, "cherry", "dAte"]);
  assert.deepEqual(await valuesOf(df, s().replace("a", "A", { n: -1 })), ["Apple", "bAnAnA", null, "cherry", "dAte"]);
  assert.throws(() => s().replace("a", "A", { n: 2 }), /supports n=1 or n=-1/);
  assert.deepEqual(await valuesOf(df, s().extract("(p+)", 1)), ["pp", null, null, null, null]);
  assert.deepEqual(await valuesOf(df, lit("banana").str.split("an")), [["b", "", "a"], ["b", "", "a"], ["b", "", "a"], ["b", "", "a"], ["b", "", "a"]]);
  assert.throws(() => s().split("a", { inclusive: true }), /not supported/);
  assert.deepEqual(await valuesOf(df, s().countMatches("a")), [1, 3, null, 0, 1]);
  assert.deepEqual(await valuesOf(df, s().countMatches("A", true)), [0, 0, null, 0, 0]);
});

test("parsing dates and timestamps, with and without formats", async () => {
  const df = await sampleFrame();
  const date = (await valuesOf(df, lit("2024-01-02").str.toDate()))[0] as Date;
  assert.equal(date.toISOString().slice(0, 10), "2024-01-02");
  const dmy = (await valuesOf(df, lit("02/01/2024").str.toDate("%d/%m/%Y")))[0] as Date;
  assert.equal(dmy.toISOString().slice(0, 10), "2024-01-02");
  assert.deepEqual(await valuesOf(df, lit("xx").str.toDate("%d/%m/%Y", { strict: false })), [null, null, null, null, null]);
  const ts = (await valuesOf(df, lit("2024-01-02 03:04:05").str.toDatetime("%Y-%m-%d %H:%M:%S")))[0] as Date;
  assert.equal(ts.toISOString(), "2024-01-02T03:04:05.000Z");
  const cast = (await valuesOf(df, lit("2024-01-02 03:04:05").str.toDatetime()))[0] as Date;
  assert.equal(cast.toISOString(), "2024-01-02T03:04:05.000Z");
});

test("padding, zero fill and JSON", async () => {
  const df = await sampleFrame();
  assert.deepEqual(await valuesOf(df, s().padStart(7, "*")), ["**apple", "*banana", null, "*cherry", "***date"]);
  assert.deepEqual(await valuesOf(df, s().padEnd(7, "*")), ["apple**", "banana*", null, "cherry*", "date***"]);
  assert.deepEqual(await valuesOf(df, lit("42").str.zfill(5)), ["00042", "00042", "00042", "00042", "00042"]);
  assert.deepEqual(await valuesOf(df, lit("-42").str.zfill(5)), ["-0042", "-0042", "-0042", "-0042", "-0042"]);
  const decoded = (await valuesOf(df, lit('{"a": 1, "t": ["x"]}').str.jsonDecode(Struct({ a: Int64, t: List(Utf8) }))))[0];
  assert.deepEqual(decoded, { a: 1, t: ["x"] });
  assert.deepEqual(await valuesOf(df, lit('{"a": {"b": 7}}').str.jsonPathMatch("$.a.b")), ["7", "7", "7", "7", "7"]);
  assert.throws(() => s().jsonDecode(""), TypeError);
});
