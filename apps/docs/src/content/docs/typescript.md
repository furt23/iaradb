---
title: TypeScript
description: Use the Iara engine from Node.js with a lazy DataFrame API and SQL.
---

The `iara` package for Node.js runs the same engine as the Python package, in the same process. Its API follows the Python one, with camelCase names. It is tested on Node.js 22 and Bun 1.4.

The package is not on npm yet. To build it from the repository, with Rust installed:

```bash
pnpm --dir node --ignore-workspace install
```

```bash
pnpm --dir node --ignore-workspace run build:native:release
```

```bash
pnpm --dir node --ignore-workspace run build
```

## Example

```ts
import * as ia from "iara";
import { col, lit, when } from "iara";

const df = await ia.fromRecords([
  { id: 1, city: "Rio", amount: 10.5 },
  { id: 2, city: "Rio", amount: 20 },
  { id: 3, city: "SP", amount: null },
]);

const summary = await df
  .lazy()
  .filter(col("id").gt(0))
  .withColumns({ band: when(col("amount").gte(15)).then(lit("high")).otherwise(lit("low")) })
  .groupBy("city")
  .agg(col("amount").sum().alias("total"), ia.len().alias("n"))
  .sort("city")
  .collect();

console.log(await summary.toRecords());
// [ { city: 'Rio', total: 30.5, n: 2 }, { city: 'SP', total: null, n: 1 } ]
```

## Differences from Python

**Async.** Anything that reads files or runs a query returns a Promise and runs off the JavaScript thread: `collect`, `fetch`, `explain`, `stream`, `sink*`, `scan*`, `read*`, `sql`, the `register*` methods of a session that read files, and every `DataFrame` method that executes. Building a plan on a `LazyFrame` or an `Expr` is synchronous, so a query is one chain with one `await` at the end. `scanParquet` and the other `scan*` functions return a Promise because they read file metadata.

**Operators.** JavaScript has no operator overloading, so expressions use methods: `plus`, `minus`, `mul`, `div`, `mod`, `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `and`, `or`, `not`, `neg` and `concat`. `1 + col("a")` is `lit(1).plus(col("a"))`.

**Arguments.** Python keyword arguments are an options object: `sort("a", { descending: true })`, `join(other, { on: "id", how: "left" })`. Named columns are a plain object: `select(col("a"), { b: col("c").plus(1) })`.

**Errors.** Errors are `Error` objects with a `code`: `IaraError`, `QueryCancelled` or `StorageError`. A JavaScript argument of the wrong type gets the code of the native layer, such as `StringExpected`.

Not available: `to_pandas` and the other pandas and Polars conversions, `widgets`, `workspace`, `preview`, `analyze`, `profile`, `explain_tree`, Python's `to_reader`, `DataFrame.__getitem__`, and restricted sessions.

## Values

`toRecords`, `toColumns`, `rows` and `item` return plain JavaScript values. `toArrow` returns an `apache-arrow` `Table`.

| Engine type | JavaScript value |
| --- | --- |
| 64-bit integers, time, duration | `number` within the safe integer range, `bigint` outside it |
| Other integers, floats | `number` |
| Date, timestamp | `Date` (precision below a millisecond is lost) |
| Decimal | `string`, such as `"-1.25"` |
| List | array |
| Struct | object |
| Binary | `Uint8Array` |

`fromRecords` and `fromColumns` infer types from the values. A column whose numbers are all whole is `Int64`, including `[1.0, 2.0]`, because JavaScript does not tell the two apart; use `cast` for a float column. A `Date` becomes a millisecond timestamp. Columns that mix types are an error.

`fromArrow` takes an `apache-arrow` `Table`. Tables are copied in both directions, through Arrow IPC.

## Large results

`iterBatches` yields Arrow record batches as the query produces them. Leaving the loop stops the query.

```ts
const lf = await ia.scanParquet("events/*.parquet");

for await (const batch of lf.filter(col("kind").eq("click")).iterBatches()) {
  console.log(batch.numRows);
}
```

The `sink*` methods write results larger than memory directly to files.

## Concurrency

Queries run on the Node.js thread pool, which also serves `fs` and DNS lookups and has 4 threads by default. Each running query holds one thread until it finishes, while the engine does the work on its own threads. A server that runs several long queries at a time should raise `UV_THREADPOOL_SIZE`.
