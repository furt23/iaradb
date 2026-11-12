import { test } from "node:test";
import assert from "node:assert/strict";
import { col, fromColumns } from "./index.js";
import { valuesOf } from "./testutil.js";

const when = (iso: string | null) => (iso === null ? null : new Date(iso));

async function dates() {
  return fromColumns({
    t: [when("2024-03-15T10:20:30Z"), when("2023-12-31T23:59:59Z"), null],
  });
}

test("date parts", async () => {
  const df = await dates();
  const t = () => col("t").dt;
  assert.deepEqual(await valuesOf(df, t().year()), [2024, 2023, null]);
  assert.deepEqual(await valuesOf(df, t().quarter()), [1, 4, null]);
  assert.deepEqual(await valuesOf(df, t().month()), [3, 12, null]);
  assert.deepEqual(await valuesOf(df, t().week()), [11, 52, null]);
  assert.deepEqual(await valuesOf(df, t().day()), [15, 31, null]);
  // the engine numbers days of the week from Sunday = 0 (DuckDB)
  assert.deepEqual(await valuesOf(df, t().weekday()), [5, 0, null]);
  assert.deepEqual(await valuesOf(df, t().ordinalDay()), [75, 365, null]);
  assert.deepEqual(await valuesOf(df, t().hour()), [10, 23, null]);
  assert.deepEqual(await valuesOf(df, t().minute()), [20, 59, null]);
  assert.deepEqual(await valuesOf(df, t().second()), [30, 59, null]);
});

test("date arithmetic and formatting", async () => {
  const df = await dates();
  const t = () => col("t").dt;
  const iso = (values: unknown[]) => values.map((v) => (v === null ? null : (v as Date).toISOString().slice(0, 10)));
  assert.deepEqual(iso(await valuesOf(df, t().truncate("month"))), ["2024-03-01", "2023-12-01", null]);
  assert.deepEqual(await valuesOf(df, t().strftime("%Y/%m/%d")), ["2024/03/15", "2023/12/31", null]);
  assert.deepEqual(iso(await valuesOf(df, t().offsetBy("1d"))), ["2024-03-16", "2024-01-01", null]);
  assert.deepEqual(iso(await valuesOf(df, t().monthStart())), ["2024-03-01", "2023-12-01", null]);
  assert.deepEqual(iso(await valuesOf(df, t().monthEnd())), ["2024-03-31", "2023-12-31", null]);
});
