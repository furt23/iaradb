# Architecture

How a query runs, and where the code lives.

## Layout

```
python/iara        Python API: Expr, LazyFrame, DataFrame, SessionContext, sql, workspace
  kernel/               Studio kernel: protocol, notebooks, dependency graph, cell runner
  cloud/                publish the engine to S3, list and remove AWS resources
crates/iara-python PyO3 bindings (Arrow C stream export; the GIL is released while a query runs)
crates/iara-core
  sql/                  SQL to logical plan (sqlparser): subqueries, join ordering, windows, recursive CTEs
  logical.rs, expr.rs   logical plan and expressions
  optimizer.rs          rule-based rewrites
  physical/             physical planning, cardinality estimates, expression evaluation
  exec/                 pipelines, hash join, hash aggregation, sort, window, recursion, spilling
  io/                   Parquet, CSV, JSON, object stores, in-memory tables
apps/web                Iara Studio (Next.js)
packages/protocol       TypeScript types of the kernel protocol
packages/ui             Studio UI components
```

## From SQL or DataFrame to result

1. SQL is parsed with sqlparser. The DataFrame API builds the same logical plan.
2. The optimizer rewrites the plan: constant folding, predicate and projection pushdown, limit and top-k pushdown into scans, eager aggregation, and subquery decorrelation. Eager aggregation applies to a `GROUP BY` over an inner join when every aggregate reads one side and can be combined (`count`, `sum`, `min`, `max`, `avg`, `count_if`, `bool_and`, `bool_or`). That side is pre-aggregated by its join keys before the join. It is used only when the estimates say the join keeps most of that side's rows and each join key has several rows. Correlated `EXISTS` and `IN` become semi or anti joins, and correlated scalar subqueries become an aggregation joined back. Decorrelation handles equality correlations only.
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
- Aggregation starts with thread-local hash tables. When there are too many distinct keys for local aggregation to shrink the data, workers hash-partition the rows. Partitions keep their rows while they fit a quarter of the memory limit and aggregate them one partition at a time at the end; a partition that fills its share folds its rows into a table shared by all threads, so memory follows the number of groups instead of the number of rows. Keys like `(id, name, city)`, where the other columns depend on an integer one, are hashed by that column and each group keeps the others once, checked per row; string columns gathered by a join are checked by their position in the shared buffers instead of byte by byte. `count`, `sum`, `min`, `max` and `avg` keep all of a group's states in one row, so an input row touches one cache line whatever the number of aggregates.

### Windows and recursion

- Ranking, offset (`lag`, `lead`, `first_value`, `last_value`, `nth_value`) and aggregate window functions, with `FILTER`, `IGNORE NULLS` and frames. Each distinct `(PARTITION BY, ORDER BY)` pair is sorted once.
- `WITH RECURSIVE` runs iteratively until no new rows appear or a `LIMIT` is reached.

## Memory and spilling

Aggregation tables, join build sides, sort buffers and window buffers reserve memory from one process-wide pool. Set the limit with `iara.set_memory_limit()` or `IARA_MEMORY_LIMIT`. When a reservation would exceed it, the operator spills to disk as LZ4-compressed Arrow IPC files:

- aggregation stops growing its partition tables and spills the remaining rows by partition, then folds each partition's rows into its table one partition at a time;
- joins fall back to a partitioned (grace) hash join;
- sort writes sorted runs and merges them;
- window functions spill by `PARTITION BY` partition.

A single partition must still fit in memory. `iara.memory_usage()` returns `{limit, used, peak, spilled}`.

## Running queries

Each query has a handle that reports finished morsels and row counts and checks a cancel flag between batches.

- `iara.running_queries()` lists running queries, `iara.cancel_query(id)` cancels one and `iara.interrupt()` cancels all of them.
- `lf.explain_tree()` returns the physical plan as nested dicts.
- `lf.profile()` returns `(DataFrame, dict)`: the result and a run profile with per-pipeline times, row counts, memory peak and spilled bytes.
- `lf.analyze()` runs the query and returns `{plan, profile, rows, requests}`, with metrics on every plan node. SQL `EXPLAIN ANALYZE` gives this as text.

## Catalog and schemas

Tables live in named schemas (`sales.orders`), and `main` is the default. `CREATE SCHEMA`, `DROP SCHEMA [CASCADE]` and `USE` manage them. A workspace declares its tables and schemas in `iara.toml`.

## Settings

| Variable | Default | Effect |
|---|---|---|
| `IARA_BATCH_SIZE` | `8192` | Rows per batch. |
| `IARA_STRING_VIEW` | `1` | `0` reads Parquet strings as `Utf8`. |
| `IARA_AGG_PARTITIONS` | `4 x threads` | Partitions of the shared tables a high-cardinality aggregation uses. |
| `IARA_MEMORY_LIMIT` | 75% of RAM on Linux, none elsewhere | Bytes, a unit (`4GB`) or a percentage (`60%`). |
| `IARA_SPILL_DIR` | system temp dir | Where spill files go. |
| `IARA_PROFILE` | `0` | `1` prints pipeline timings to stderr. |

Object store settings are in [storage-and-cloud.md](storage-and-cloud.md).
