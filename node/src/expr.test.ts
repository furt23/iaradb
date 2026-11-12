import { test } from "node:test";
import assert from "node:assert/strict";
import { col, lit, fromColumns, type DataFrame, type Expr } from "./index.js";
import { sampleFrame, valuesOf } from "./testutil.js";

/** The aggregate's single value over the whole frame. */
async function aggOf(df: DataFrame, expr: Expr): Promise<unknown> {
  const out = await df.lazy().agg(expr.alias("r")).collect();
  return (await out.toColumns()).r[0];
}

function assertNear(actual: unknown, expected: number, eps = 1e-6): void {
  assert.equal(typeof actual, "number");
  assert.ok(Math.abs((actual as number) - expected) <= eps, `expected ${String(actual)} to be near ${expected}`);
}

test("arithmetic operators", async () => {
  const df = await sampleFrame();
  assert.deepEqual(await valuesOf(df, col("a").plus(col("b"))), [11, 22, 33, 44, null]);
  assert.deepEqual(await valuesOf(df, col("b").minus(1)), [9, 19, 29, 39, 49]);
  assert.deepEqual(await valuesOf(df, col("a").mul(2)), [2, 4, 6, 8, null]);
  assert.deepEqual(await valuesOf(df, col("f").div(2)), [0.75, -1.125, 0, null, 2]);
  // remainder takes the sign of the divisor, as Polars does
  assert.deepEqual(await valuesOf(df, col("b").mod(7)), [3, 6, 2, 5, 1]);
  assert.deepEqual(await valuesOf(df, col("b").mod(-7)), [-4, -1, -5, -2, -6]);
});

test("comparison, logical and string concatenation operators", async () => {
  const df = await sampleFrame();
  assert.deepEqual(await valuesOf(df, col("a").eq(2)), [false, true, false, false, null]);
  assert.deepEqual(await valuesOf(df, col("a").neq(2)), [true, false, true, true, null]);
  assert.deepEqual(await valuesOf(df, col("a").lt(3)), [true, true, false, false, null]);
  assert.deepEqual(await valuesOf(df, col("a").lte(2)), [true, true, false, false, null]);
  assert.deepEqual(await valuesOf(df, col("a").gt(2)), [false, false, true, true, null]);
  assert.deepEqual(await valuesOf(df, col("a").gte(2)), [false, true, true, true, null]);
  assert.deepEqual(await valuesOf(df, col("a").gt(1).and(col("a").lt(4))), [false, true, true, false, null]);
  assert.deepEqual(await valuesOf(df, col("a").eq(1).or(col("a").eq(4))), [true, false, false, true, null]);
  assert.deepEqual(await valuesOf(df, col("a").gt(2).not()), [true, true, false, false, null]);
  assert.deepEqual(await valuesOf(df, col("a").neg()), [-1, -2, -3, -4, null]);
  assert.deepEqual(await valuesOf(df, col("s").concat("!")), ["apple!", "banana!", null, "cherry!", "date!"]);
});

test("general methods: alias, cast, nulls, isIn, between, fillNull", async () => {
  const df = await sampleFrame();
  const named = await df.select(col("a").alias("renamed"));
  assert.deepEqual(named.columns, ["renamed"]);
  assert.deepEqual(await valuesOf(df, col("a").cast("float64")), [1, 2, 3, 4, null]);
  assert.deepEqual(await valuesOf(df, col("a").cast("utf8")), ["1", "2", "3", "4", null]);
  assert.deepEqual(await valuesOf(df, col("a").cast("int64", false)), [1, 2, 3, 4, null]);
  assert.deepEqual(await valuesOf(df, col("a").isNull()), [false, false, false, false, true]);
  assert.deepEqual(await valuesOf(df, col("a").isNotNull()), [true, true, true, true, false]);
  // SQL semantics: a null is not in any list, so the answer is null
  assert.deepEqual(await valuesOf(df, col("a").isIn([1, 3])), [true, false, true, false, null]);
  assert.deepEqual(await valuesOf(df, col("a").isBetween(2, 3)), [false, true, true, false, null]);
  assert.deepEqual(await valuesOf(df, col("a").between(2, 3)), [false, true, true, false, null]);
  assert.deepEqual(await valuesOf(df, col("a").fillNull(0)), [1, 2, 3, 4, 0]);
});

test("aggregates over the whole frame", async () => {
  const df = await sampleFrame();
  assert.equal(await aggOf(df, col("a").sum()), 10);
  assert.equal(await aggOf(df, col("a").mean()), 2.5);
  assert.equal(await aggOf(df, col("a").avg()), 2.5);
  assert.equal(await aggOf(df, col("a").min()), 1);
  assert.equal(await aggOf(df, col("a").max()), 4);
  assert.equal(await aggOf(df, col("a").count()), 4);
  assert.equal(await aggOf(df, col("g").nUnique()), 2);
  assertNear(await aggOf(df, col("b").std()), Math.sqrt(250));
  assertNear(await aggOf(df, col("b").std(0)), Math.sqrt(200));
  assertNear(await aggOf(df, col("b").var()), 250);
  assertNear(await aggOf(df, col("b").var(0)), 200);
  assert.equal(await aggOf(df, col("b").median()), 30);
  assert.equal(await aggOf(df, col("b").first()), 10);
  assert.equal(await aggOf(df, col("b").last()), 50);
  assert.equal(await aggOf(df, col("b").quantile(0.5)), 30);
  assert.equal(await aggOf(df, col("b").quantile(0.25)), 20);
  assert.equal(await aggOf(df, col("b").quantile(0.3)), 22);
  assert.equal(await aggOf(df, col("b").quantile(0.5, "disc")), 30);
  assert.equal(await aggOf(df, col("b").approxQuantile(0.5)), 30);
  assert.equal(await aggOf(df, col("a").product()), 24);
  assert.equal(await aggOf(df, col("a").gt(0).all()), true);
  assert.equal(await aggOf(df, col("a").gt(3).any()), true);
  assert.equal(await aggOf(df, col("s").maxBy(col("b"))), "date");
  assert.equal(await aggOf(df, col("s").minBy(col("b"))), "apple");
  assertNear(await aggOf(df, col("a").corr(col("b"))), 1);
  assertNear(await aggOf(df, col("a").cov(col("b"))), 50 / 3);
  assertNear(await aggOf(df, col("b").slope(col("a"))), 10);
  assert.deepEqual(await aggOf(df, col("a").implode()), [1, 2, 3, 4, null]);
});

test("filter restricts an aggregate, before or after it is applied", async () => {
  const df = await sampleFrame();
  assert.equal(await aggOf(df, col("b").filter(col("a").gt(2)).sum()), 70);
  assert.equal(await aggOf(df, col("b").sum().filter(col("a").gt(2))), 70);
  assert.equal(await aggOf(df, col("b").filter(col("a").gt(2)).max()), 40);
  assert.equal(await aggOf(df, col("b").filter(col("a").gt(2)).count()), 2);
  assert.equal(await aggOf(df, col("b").filter(col("a").gt(2)).mean()), 35);
  assert.equal(await aggOf(df, col("b").filter(col("a").gt(2)).min()), 30);
  assert.equal(await aggOf(df, col("b").filter(col("a").gt(2)).nUnique()), 2);
  assert.equal(await aggOf(df, col("b").filter(col("a").gt(2)).median()), 35);
  assert.equal(await aggOf(df, col("b").filter(col("a").gt(2)).first()), 30);
  assert.equal(await aggOf(df, col("b").filter(col("a").gt(2)).last()), 40);
  assert.equal(await aggOf(df, col("b").filter(col("a").gt(2)).product()), 1200);
  assert.equal(await aggOf(df, col("a").gt(0).filter(col("b").gt(20)).all()), true);
  assert.equal(await aggOf(df, col("a").gt(1).filter(col("b").gt(20)).any()), true);
  assert.equal(await aggOf(df, col("b").filter(col("a").gt(2)).quantile(0.5)), 35);
  assert.equal(await aggOf(df, col("s").filter(col("b").gt(20)).maxBy(col("b"))), "date");
  assert.deepEqual(await aggOf(df, col("b").filter(col("a").gt(2)).implode()), [30, 40]);
  // without an aggregate, filter is only a restriction: as an expression it is the plain column (as in Python)
  assert.deepEqual(await valuesOf(df, col("b").filter(col("a").gt(2))), [10, 20, 30, 40, 50]);
});

test("math functions", async () => {
  const df = await sampleFrame();
  assert.deepEqual(await valuesOf(df, col("f").abs()), [1.5, 2.25, 0, null, 4]);
  assert.deepEqual(await valuesOf(df, col("f").round(0)), [2, -2, 0, null, 4]);
  assert.deepEqual(await valuesOf(df, col("f").floor()), [1, -3, 0, null, 4]);
  assert.deepEqual(await valuesOf(df, col("f").ceil()), [2, -2, 0, null, 4]);
  assert.deepEqual(await valuesOf(df, col("f").sign()), [1, -1, 0, null, 1]);
  assert.deepEqual(await valuesOf(df, col("a").pow(2)), [1, 4, 9, 16, null]);
  assert.deepEqual(await valuesOf(df, col("a").clip(2, 3)), [2, 2, 3, 3, null]);
  assert.deepEqual(await valuesOf(df, col("a").clip(null, 3)), [1, 2, 3, 3, null]);
  assert.deepEqual(await valuesOf(df, col("a").clip(2)), [2, 2, 3, 4, null]);
  assert.deepEqual(await valuesOf(df, col("f").eqMissing(lit(null))), [false, false, false, true, false]);
  assert.deepEqual(await valuesOf(df, col("f").neMissing(lit(null))), [true, true, true, false, true]);
  assertNear((await valuesOf(df, col("b").sqrt()))[3] as number, Math.sqrt(40));
  assertNear((await valuesOf(df, col("a").exp()))[0] as number, Math.E);
  assertNear((await valuesOf(df, col("b").log()))[0] as number, Math.log(10));
  assertNear((await valuesOf(df, col("b").log10()))[0] as number, 1);
  assertNear((await valuesOf(df, lit(0).sin()))[0] as number, 0);
  assertNear((await valuesOf(df, lit(0).cos()))[0] as number, 1);
  assertNear((await valuesOf(df, lit(0).tan()))[0] as number, 0);
  assertNear((await valuesOf(df, lit(0).arcsin()))[0] as number, 0);
  assertNear((await valuesOf(df, lit(1).arccos()))[0] as number, 0);
  assertNear((await valuesOf(df, lit(0).arctan()))[0] as number, 0);
  assertNear((await valuesOf(df, lit(1).arctan2(1)))[0] as number, Math.PI / 4);
  assertNear((await valuesOf(df, lit(Math.PI).degrees()))[0] as number, 180);
  assertNear((await valuesOf(df, lit(180).radians()))[0] as number, Math.PI);
});

test("NaN tests distinguish NaN from null", async () => {
  const df = await fromColumns({ f: [Number.NaN, 1, null] });
  assert.deepEqual(await valuesOf(df, col("f").isNan()), [true, false, null]);
  assert.deepEqual(await valuesOf(df, col("f").isNotNan()), [false, true, null]);
});
