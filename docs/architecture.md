# Architecture

How a query runs, and where the code lives.

## Layout

```
python/workhouse        Python API: Expr, LazyFrame, DataFrame, SessionContext, sql, workspace
  kernel/               Studio kernel: protocol, notebooks, dependency graph, cell runner
  cloud/                publish the engine to S3, list and remove AWS resources
crates/workhouse-python PyO3 bindings (Arrow C stream export; the GIL is released while a query runs)
crates/workhouse-core
  sql/                  SQL to logical plan (sqlparser): subqueries, join ordering, windows, recursive CTEs
  logical.rs, expr.rs   logical plan and expressions
  optimizer.rs          rule-based rewrites
  physical/             physical planning, cardinality estimates, expression evaluation
  exec/                 pipelines, hash join, hash aggregation, sort, window, recursion, spilling
  io/                   Parquet, CSV, JSON, object stores, in-memory tables
apps/web                Workhouse Studio (Next.js)
packages/protocol       TypeScript types of the kernel protocol
packages/ui             Studio UI components
```

## From SQL or DataFrame to result

1. SQL is parsed with sqlparser. The DataFrame API builds the same logical plan.
2. The optimizer rewrites the plan: constant folding, predicate and projection pushdown, limit and top-k pushdown into scans, and subquery decorrelation. Correlated `EXISTS` and `IN` become semi or anti joins, and correlated scalar subqueries become an aggregation joined back. Decorrelation handles equality correlations only.
3. Joins of up to 12 relations are ordered by dynamic programming over cardinality estimates, larger ones greedily. Equalities are grouped into classes, so `a = b AND b = c` also lets `a` join `c` directly. For Parquet the estimates come from row group counts, min/max statistics and distinct counts.
4. The physical plan is cut into pipelines at hash join builds, hash aggregations and sorts.

## Execution

- A pipeline starts at a source split into morsels: a Parquet row group, a byte range of a CSV file, or a slice of an in-memory table. Worker threads take morsels from a Rayon pool and push them through the pipeline's operators into a thread-local sink. The sinks are merged when the input is exhausted.
- Batches are 8,192 rows by default.
- Results reach the consumer in morsel order. `sink_parquet`, `sink_csv` and `sink_ndjson` write while the query runs, and `lf.iter_batches()` yields batches through a bounded channel.
- Parquet strings are read as Arrow `Utf8View`.
- Hive-style `key=value` directories become partition columns. Filters on them skip directories before any file is read.

### Joins and aggregation

- Joins: inner, left, right, full, semi and anti, with extra non-equality predicates. The hash table is built in parallel. Integer keys (several are packed into one) use a radix-partitioned table whose directory carries a small bloom filter per bucket, so most probes for missing keys cost one memory access. For outer, semi and anti joins the smaller side is the build side.
- `ORDER BY ... LIMIT k` over a filtered Parquet scan (k up to 10,000) sorts on the filter and sort columns only, then reads the other columns of the k rows by position.
- Aggregation starts with thread-local hash tables. It switches to radix partitioning when there are too many distinct keys for local aggregation to shrink the data.

### Windows and recursion

- Ranking, offset (`lag`, `lead`, `first_value`, `last_value`, `nth_value`) and aggregate window functions, with `FILTER`, `IGNORE NULLS` and frames. Each distinct `(PARTITION BY, ORDER BY)` pair is sorted once.
- `WITH RECURSIVE` runs iteratively until no new rows appear or a `LIMIT` is reached.

## Memory and spilling

Aggregation tables, join build sides, sort buffers and window buffers reserve memory from one process-wide pool. Set the limit with `wh.set_memory_limit()` or `WORKHOUSE_MEMORY_LIMIT`. When a reservation would exceed it, the operator spills to disk as LZ4-compressed Arrow IPC files:

- aggregation spills radix partitions and aggregates them one at a time;
- joins fall back to a partitioned (grace) hash join;
- sort writes sorted runs and merges them;
- window functions spill by `PARTITION BY` partition.

A single partition must still fit in memory. `wh.memory_usage()` returns `{limit, used, peak, spilled}`.

## Running queries

Each query has a handle that reports finished morsels and row counts and checks a cancel flag between batches.

- `wh.running_queries()` lists running queries, `wh.cancel_query(id)` cancels one and `wh.interrupt()` cancels all of them.
- `lf.explain_tree()` returns the physical plan as nested dicts.
- `lf.profile()` returns `(DataFrame, dict)`: the result and a run profile with per-pipeline times, row counts, memory peak and spilled bytes.
- `lf.analyze()` runs the query and returns `{plan, profile, rows, requests}`, with metrics on every plan node. SQL `EXPLAIN ANALYZE` gives this as text.

## Catalog and schemas

Tables live in named schemas (`sales.orders`), and `main` is the default. `CREATE SCHEMA`, `DROP SCHEMA [CASCADE]` and `USE` manage them. A workspace declares its tables and schemas in `workhouse.toml`.

## Settings

| Variable | Default | Effect |
|---|---|---|
| `WORKHOUSE_BATCH_SIZE` | `8192` | Rows per batch. |
| `WORKHOUSE_STRING_VIEW` | `1` | `0` reads Parquet strings as `Utf8`. |
| `WORKHOUSE_AGG_PARTITIONS` | `4 x threads` | Partitions when aggregation switches to radix mode. |
| `WORKHOUSE_MEMORY_LIMIT` | 75% of RAM on Linux, none elsewhere | Bytes, a unit (`4GB`) or a percentage (`60%`). |
| `WORKHOUSE_SPILL_DIR` | system temp dir | Where spill files go. |
| `WORKHOUSE_PROFILE` | `0` | `1` prints pipeline timings to stderr. |

Object store settings are in [storage-and-cloud.md](storage-and-cloud.md).
