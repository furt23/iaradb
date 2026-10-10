# Engine Architecture & Internals

Workhouse is a vectorized, parallel query execution engine written in Rust on top of Apache Arrow. It is designed to maximize the throughput of modern multi-core machines through morsel-driven pipelined execution, out-of-core streaming, and hardware-conscious memory layouts.

---

## Codebase Layout

```
python/workhouse        Python API (Expr, LazyFrame, DataFrame, SessionContext, sql, workspace)
  kernel/               Studio kernel: protocol, marimo notebooks, dependency graph, cell runner
crates/workhouse-python PyO3 bindings: Arrow C stream export, GIL released while executing
crates/workhouse-core
  sql/                  SQL -> logical plan (sqlparser), subquery decorrelation, join ordering,
                        window clauses, recursive CTEs
  logical.rs, expr.rs   logical plan and expressions; window.rs: window expressions
  optimizer.rs          rule-based rewrites
  physical/             physical planning, cardinality estimation, expression evaluation
  exec/                 pipelines, filter/project, hash join, hash aggregation, sort, window/, recursion
  io/                   Parquet (statistics pruning, string views), CSV, in-memory tables
apps/web                Workhouse Studio (Next.js): app routes, features/*, server/*
packages/protocol       TypeScript types of the kernel protocol
packages/ui             The Observatory design system and components
```

---

## Execution Model

### Morsel-Driven Push Pipelines
A logical query plan is partitioned into physical execution pipelines at pipeline breakers (hash join build, hash aggregation, and sorting).
- Each pipeline begins at a source split into granular morsels: individual Parquet row groups, byte ranges, or slices of in-memory data.
- Morsels flow through a fused chain of streaming operators (filters, projections, unpackers) directly into thread-local accumulators in the pipeline sink.
- Thread-local states are combined during a parallel `finalize` phase.
- Morsel scheduling is managed dynamically across available CPU cores using a Rayon work-stealing pool.

### Batch Sizing & L2 Cache Locality
Workhouse operates on vectors of **8,192 rows** per batch by default. Sizing batches to 8,192 rows keeps the working set of a fused operator chain within CPU L2 cache, measuring approximately 25% faster than 64K-row batches in microbenchmarks.

### Vectorized Arrow Expressions
Expressions evaluate directly on Apache Arrow array kernels with specialized fast paths:
- `LIKE` string matching compiles to specialized prefix, suffix, and SIMD `memchr`-based substring algorithms.
- Literal values are converted to the target column type at plan time to eliminate runtime casting overhead.
- Unaliased expressions in projections automatically adopt root column names by default.

### Query Observability & Cancellation
Every query is assigned an observable execution handle registered in a global handle table:
- Pipelines report completed morsels and row counts in real time, checking cancellation flags between batch processing steps.
- Cancellation and monitoring are exposed to Python via `wh.running_queries()` and `wh.interrupt()`.
- Plan inspection is accessible through `LazyFrame.profile()`, `LazyFrame.explain_tree()`, `LazyFrame.analyze()`, and SQL `EXPLAIN ANALYZE`. Profiling tracks operator-level self-time, processed row counts, memory peaks, and disk spill metrics.

---

## Memory Management & Out-of-Core Spilling

### Process-Wide Memory Pool
Execution operators reserve working memory (aggregation hash tables, join build tables, sort runs, and window buffers) from a centralized memory pool (`wh.set_memory_limit()`).
- In the absence of a memory limit, operators incur no locking overhead and run along optimized fast paths.
- Memory usage metrics are inspectable via `wh.memory_usage()` returning `{limit, used, peak, spilled}`.

### Out-of-Core Operators
When a memory allocation exceeds the pool limit, operators spill intermediate state to disk using Arrow IPC files compressed with LZ4:
- **Radix Aggregation Spilling**: Hash aggregation dynamically transitions to radix partitioning. Each partition spills to an independent file, and partitions are finalized and aggregated one by one.
- **Grace Hash Join**: Hash joins switch to Grace hash joins: build and probe sides are partitioned into temporary disk buckets based on key hashes. Each partition pair is then streamed and joined as an independent morsel.
- **External K-Way Merge Sort**: Sorters write presorted runs to disk. A k-way merge reads them back using an optimized row format. Hidden row index columns preserve tie-breaking stability.
- **Window Function Partition Spilling**: Window functions sharing partition keys (`PARTITION BY`) spill partitions to disk and evaluate each partition independently.
- **String View Compaction**: String view columns (`Utf8View`) are compacted prior to spilling, ensuring slices never write unbounded source buffers to disk.

### Streaming Results
Results stream directly to consumers in row order without requiring full materialization in memory:
- Sinks stream output batches via a reordering buffer that restores deterministic morsel ordering.
- `sink_parquet` and `sink_csv` write streams directly to local files or object store multipart uploads.
- Python consumers read streamed batches through a bounded channel (`lf.iter_batches()`), applying backpressure to the query engine.

---

## Hash Joins & Ordering

### Lock-Free Hash Table Construction
Hash tables are built in parallel using lock-free chained bucket arrays populated via atomic pointer swaps:
- Multi-column integer keys whose combined ranges fit within 64 bits are packed into a single primitive `i64`.
- Arbitrary composite and string keys use the Arrow row-format representation.

### Comprehensive Join Semantics
Workhouse implements inner, left, right, full, semi, and anti joins, as well as residual non-equi predicates.
- Outer, semi, and anti joins dynamically swap build and probe sides to build against the smaller relation.
- Semi and anti joins track match presence using bitsets when the preserved side is smaller.

### Cost-Based Join Ordering
Greedy Operator Ordering (GOO) determines join trees from the SQL join graph:
- Cardinality estimates leverage Parquet metadata: row group counts, min/max statistics for range selectivity, integer key distinct value counts, and sampled NDVs for string columns.

---

## High-Performance Aggregation

### Adaptive Radix Pre-Aggregation
When group keys exhibit high cardinality and local aggregation fails to reduce dataset volume, the operator transitions automatically to radix partitioning, parallelizing downstream aggregations without a global merge bottleneck.

### Type-Specialized Key Interning
- Primitive integer and floating point keys reside in cache-efficient SwissTable layouts.
- Short strings are matched directly using their 16-byte `Utf8View` inline headers.
- Composite keys map to dense surrogate identifiers.

### Dependent Key Optimization
For wide key combinations such as `(c_custkey, c_name, c_address)`, the engine hashes only the primary integer key (`c_custkey`) and verifies dependent column equality per group. If a row breaks the functional dependency, groups are split dynamically without changing existing IDs.

---

## Query Optimizer

The optimizer applies cost- and rule-based transformations:
- **Predicates & Projections**: Constant folding, boolean simplification, predicate pushdown (including cross-table disjunction pushdown), projection pruning, and limit/top-k pushdown into table scans.
- **Subquery Decorrelation**:
  - `EXISTS` and `IN` transform into semi or anti joins.
  - Correlated scalar subqueries become an aggregation with a left outer join.
  - Correlated subquery scopes are constrained using "magic set" semi-joins generated from correlation key providers.
- **Semi-Join Reduction & CTE Optimization**: Semi-joins push below intermediate joins when input sizes shrink. Common Table Expressions (CTEs) referenced multiple times materialize once.

---

## Window Functions & Recursion

### Window Functions
Supports standard window functions:
- Ranking: `row_number`, `rank`, `dense_rank`, `percent_rank`, `cume_dist`, `ntile`.
- Value offsets: `lag`, `lead` (with custom defaults and `IGNORE NULLS`), `first_value`, `last_value`, `nth_value`.
- Aggregates over windows: `SUM`, `AVG`, `COUNT`, `MIN`, `MAX`, `VARIANCE`, `STDDEV`, including `FILTER` clauses and `DISTINCT` across whole partitions.

### Optimized Window Evaluation
- Columns are sorted once per unique `(PARTITION BY, ORDER BY)` signature.
- Compact fixed-width keys pack with row offsets into 64-bit or 128-bit integers, executing via parallel integer sorts.
- Sliding frames operate in $O(1)$ amortized time per row for sums, counts, and averages, and $O(1)$ for running minimum/maximum via monotonic double-ended queues.

### Recursive CTEs
`WITH RECURSIVE` queries execute iteratively over working tables with `UNION ALL` or deduplicated `UNION` until reaching a fixed point or an early `LIMIT` termination.

---

## I/O, Storage & Formats

### Zero-Copy Parquet String Handling
Parquet string columns decode directly into Arrow `Utf8View` arrays without copy operations. Strings under 12 bytes live inline inside array slots. String buffers are compacted at materialization boundaries so pipelines avoid retaining dead buffer references.

### Hive-Style Partitioning
Datasets stored in `key=value` directory structures automatically project partition columns (integers, dates, or strings). Predicate evaluation prunes unmatching directory paths before disk or network reads occur.

### Transactional Catalogs & Schemas
Tables reside in named schemas (`sales.orders`, defaulting to `main`).
- Schema management via `CREATE SCHEMA`, `DROP SCHEMA [CASCADE]`, and `USE`.
- Catalog declarations persist in `workhouse.toml`.
- SQL DDL commands include `COPY TO`, `CREATE TABLE ... AS`, `INSERT INTO`, and `DROP TABLE`.
