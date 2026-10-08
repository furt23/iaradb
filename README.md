# Workhouse Engine

A parallel, vectorized query engine for structured data: a Rust core on Apache Arrow with a Python API in the style of Polars' `LazyFrame` and a SQL frontend. Workhouse covers the single-node jobs people use Spark or Dask for: scanning Parquet and CSV, filtering, joining, aggregating, sorting and writing results. It uses every core of one machine through morsel-driven pipelines.

```python
import workhouse as wh
from workhouse import col

revenue = (
    wh.scan_parquet("data/lineitem")                       # a file, a directory or a glob
    .filter(col("l_shipdate") >= wh.lit("1995-01-01").cast("date"))
    .join(wh.scan_parquet("data/orders"), left_on="l_orderkey", right_on="o_orderkey")
    .group_by("o_orderpriority")
    .agg(
        revenue=(col("l_extendedprice") * (1 - col("l_discount"))).sum(),
        orders=col("l_orderkey").n_unique(),
    )
    .sort("revenue", descending=True)
)
print(revenue.explain())          # optimized logical plan + physical plan
df = revenue.collect()            # runs in parallel, GIL released
df.to_polars(); df.to_pandas(); df.to_arrow()   # zero-copy via the Arrow C stream interface
```

```python
ctx = wh.SessionContext()
ctx.register_parquet("lineitem", "data/lineitem")
ctx.sql("""
    select l_returnflag, l_linestatus, count(*) as n, avg(l_quantity) as avg_qty
    from lineitem where l_shipdate <= date '1998-09-02'
    group by all order by 1, 2
""").collect()

wh.sql("select k, sum(v) from t group by k", t=pyarrow_table)   # pyarrow / pandas / polars inputs
```

Paths may be object store URLs. Credentials come from the environment (`AWS_ACCESS_KEY_ID`, ...) or the EC2 instance profile; other settings are *storage options*:

```python
wh.scan_parquet("s3://bucket/tpch/lineitem/")                    # a prefix, an object or a glob (`**/*.parquet`)
wh.set_storage_options("s3://bucket", {"region": "us-east-1"})  # defaults for every URL under a prefix
ctx.register_parquet("t", "s3://bucket/t/", storage_options={"endpoint": "http://localhost:9000"}, lazy=True)
ctx.sql("select count(*) from read_parquet('s3://bucket/t/*.parquet', region => 'us-east-1')")
df.write_parquet("s3://bucket/out/result.parquet")               # multipart upload
```

Data larger than memory works under a memory limit: beyond it aggregations, joins, sorts and window functions spill to disk, and results can be written or read while the query produces them, without collecting them:

```python
wh.set_memory_limit("4GB")              # or WORKHOUSE_MEMORY_LIMIT (default: 75% of RAM on Linux)
lf.sink_parquet("s3://bucket/out/big.parquet")   # streamed to a file (or sink_csv); returns the row count
for batch in lf.iter_batches(): ...     # pyarrow RecordBatches as they are produced (lf.to_reader() too)
pl.from_arrow(lf); pa.table(lf)         # LazyFrames are lazy Arrow C streams
wh.memory_usage()                       # {"limit", "used", "peak", "spilled"}
```

Window functions work in both APIs: `OVER (PARTITION BY .. ORDER BY .. ROWS | RANGE | GROUPS ..)`, named windows (`WINDOW w AS (..)`) and `QUALIFY` in SQL, and Polars-style `over()` on expressions:

```python
lf.with_columns(
    demeaned=(col("x") - col("x").mean()).over("g"),
    rank=col("score").rank("dense", descending=True).over("g"),
    prev=col("price").shift(1).over("ticker", order_by="ts"),
    ma7=col("price").rolling_mean(7).over("ticker", order_by="ts"),
    running=col("qty").cum_sum().over("g", order_by="ts"),
).filter(wh.row_number().over("g", order_by="ts") <= 3)

ctx.sql("""
    with recursive chain as (
        select id, manager, 0 as depth from emp where manager is null
        union all
        select e.id, e.manager, c.depth + 1 from emp e join chain c on e.manager = c.id)
    select depth, count(*) from chain group by depth
""")
```

## Performance

All 22 TPC-H queries, comparing Workhouse against DuckDB 1.5.6 and Polars 1.44.2 (Polars runs its native lazy-API implementations of the queries). Every engine reads the same Parquet files (ZSTD, double columns). The figures are median wall time after a warm-up, and every engine's result was checked against DuckDB's.

Test machine: AMD Ryzen 5 5600G (6 cores / 12 threads), 16 GB RAM, Windows 11, Python 3.12.

| Scale factor | Workhouse | DuckDB | Polars |
|---|---:|---:|---:|
| **SF1**, sum of 22 queries | **1.02 s** | 1.50 s | 1.99 s |
| SF1, geometric mean | **40.3 ms** | 59.1 ms | 60.5 ms |
| **SF10**, sum of 22 queries | **9.87 s** | 13.94 s | 21.54 s |
| SF10, geometric mean | **359 ms** | 530 ms | 597 ms |

<details><summary>Per query at SF10 (ms)</summary>

| Q | Workhouse | DuckDB | Polars | | Q | Workhouse | DuckDB | Polars |
|---|---:|---:|---:|---|---|---:|---:|---:|
| 1 | **469** | 635 | 1972 | | 12 | **205** | 359 | 453 |
| 2 | **159** | 200 | 164 | | 13 | **704** | 924 | 1289 |
| 3 | **444** | 558 | 475 | | 14 | **284** | 472 | 301 |
| 4 | **230** | 324 | 630 | | 15 | **282** | 457 | 302 |
| 5 | **593** | 662 | 693 | | 16 | 168 | 300 | **139** |
| 6 | **151** | 277 | 308 | | 17 | 426 | 631 | **399** |
| 7 | **461** | 687 | 540 | | 18 | **862** | 1030 | 2423 |
| 8 | **553** | 827 | 793 | | 19 | **339** | 601 | 476 |
| 9 | **1128** | 1514 | 2708 | | 20 | **429** | 563 | 1234 |
| 10 | 752 | **722** | 791 | | 21 | **1024** | 1765 | 5107 |
| 11 | **95** | 132 | 179 | | 22 | **110** | 305 | 163 |

</details>

## Workhouse Studio

A workspace for the engine in the browser, in the spirit of Databricks for Spark: notebooks that mix Python and SQL, a data catalog, a SQL editor with query history, query profiles and plans, and Git.

```bash
pnpm install                                   # the web app (Next.js + MUI)
python examples/workspace/setup_data.py        # example data: TPC-H at scale 0.1
workhouse serve examples/workspace             # or: pnpm dev (uses the example workspace)
```

- **Workspaces.** A workspace is a directory with a `workhouse.toml` catalog of named Parquet/CSV datasets (`workhouse init` creates one). Every notebook and the SQL editor can query those tables by name. Scripts get the same session with `ws = wh.workspace()`.
- **Notebooks in marimo's format.** A notebook is a `.py` file: each cell is a function whose parameters are the names it reads and whose return values are the names it defines. Files diff cleanly in Git, open in marimo, and run as plain scripts (`python notebook.py`).
- **Reactive cells.** Running a cell also runs every cell that depends on it, plus ancestors that were edited or never ran, in dependency order. Python and SQL cells share values: a DataFrame defined in Python is a table in SQL, and a SQL cell's result is a variable for the cells after it.
- **Results, profiles and plans.** Results stay in the kernel and reach the browser page by page, with sorting and CSV/Parquet export. Large results are written to disk while the query runs and memory-mapped back, so they can be larger than the kernel's memory; sorting them in the table runs in the engine, out of core. SQL cells and lazy frames also show the per-pipeline profile of their run (time, rows in/out, memory peak, bytes spilled) and the physical plan. Running queries report live progress and can be interrupted.
- **Tabs and split panes.** Notebooks open as tabs, in up to four resizable panes (side by side, stacked or in a grid); tabs move between panes and are remembered. Open notebooks keep their state, outputs and running cells while you switch tabs, panes or pages: each renders once into its own DOM node, and panes only attach it.
- **Editing.** Cells are reordered by dragging their handle (or with the keyboard), their code and output can be hidden, and the toolbar shows the notebook's execution time (live during a run). Python cells get completions with signatures and docs, and signature help while typing a call, from jedi over the cell and the notebook's live values. Syntax errors, names no cell defines, names another cell already defines, and SQL errors are underlined as you type. All of this is computed in the kernel, on its own thread, so it keeps working while a cell runs.
- **Clusters, as in Databricks.** The Compute page creates clusters (an EC2 machine size, an idle time after which it terminates) and starts and terminates them; a cluster's machine exists only while it runs, is ready in under a minute and reads data straight from S3 with a role limited to the workspace's buckets. Every notebook attaches to a cluster from its toolbar (many notebooks can share one, each with its own kernel there); the SQL editor and the catalog use the default cluster. Clusters terminate after their idle time, and their machines power themselves off if the Studio goes away. The Studio owns the workspace's files (notebooks, `workhouse.toml`): kernels receive them and only compute. A "Local" cluster (kernels on the Studio's own machine) exists in development.
- **File tree.** Every file and folder has a "…" menu (and a right-click menu): rename or move, duplicate, download, copy the path, delete, and new notebooks and folders inside folders. Open notebooks that are renamed or moved keep their kernel, values and cluster.
- **Execution stays on the server.** The browser only renders. Next.js server functions and route handlers talk to one Python kernel per notebook (`python -m workhouse.kernel`) over a JSON-lines protocol. Long runs stream events over server-sent events.

```
browser (React + MUI, renders only)
   │  server actions (short calls) · /api/run (SSE: cell states, output, progress) · /api/assist
Next.js server ── apps/web/src/server   kernel manager · workspace files · Git
   │  JSON lines over stdio (a child process, or ssh to a compute target)
kernel (python -m workhouse.kernel) ── notebook graph · cell runner · results · catalog
   │
workhouse-core (Rust)                  cancellable, observable queries
```

## Architecture

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
packages/ui             the Observatory theme and brand components
```

### Execution
- **Morsel-driven push pipelines.** A plan is cut into pipelines at the breakers (join build, aggregation, sort). Each pipeline has a source split into morsels: Parquet row groups or row ranges, or slices of in-memory data. A chain of fused streaming operators follows, then a sink with thread-local state that merges in `finalize`. Morsels run on a rayon work-stealing pool.
- **Batches of 8192 rows.** This keeps the working set of a fused pipeline in L2 cache. It measured about 25% faster than 64K-row batches.
- **Vectorized expressions** run on Arrow kernels, with specialized paths where they matter. LIKE patterns compile to prefix, suffix and `memchr`-based substring searches. Literals are adapted to the column type at plan time.
- **Cancellable, observable queries.** Every query has a handle in a global registry. Pipelines report morsels done and rows in/out, and check the handle for cancellation between batches. `wh.running_queries()`, `wh.interrupt()`, `LazyFrame.profile()` and `LazyFrame.explain_tree()` expose this to Python.

### Memory and spilling
- **A memory pool.** Operators reserve the memory of the state they keep (aggregation tables, join build sides, sort and window inputs) from one process-wide pool. Without a limit this costs nothing: the fast paths are the same, and TPC-H SF10 runs within 1% of the time it took before spilling existed.
- **Out-of-core operators.** When a reservation fails, the operator spills to Arrow IPC files compressed with LZ4 (string views are compacted first, so a slice never writes its whole buffer). Aggregations switch to radix partitions and spill each partition to its own file, then aggregate the partitions one at a time. Hash joins become grace hash joins: build and probe are partitioned to disk by key hash, and each partition is joined as a morsel of the next pipeline, for every join type. Sorts write sorted runs, which a k-way merge on the row format reads back; hidden position columns keep ties in input order. Window functions whose windows share their `PARTITION BY` keys are partitioned to disk by those keys, and each partition is evaluated on its own.
- **Streaming results.** A plan's result is handed out in order as it is produced: pipelines stream through a sink that reorders morsels, and a sort's runs are merged straight into it. `sink_parquet` / `sink_csv` write that stream to files or multipart uploads. Python readers get it over a bounded channel from a query thread, so a slow reader slows the query down instead of filling memory, and dropping the reader cancels the query. Query profiles report each query's memory peak and spilled bytes.

### Joins
- **Parallel lock-free hash table build.** Chained buckets are filled with atomic swaps. Integer multi-column keys are packed into a single `i64` when their value ranges fit; other keys go through the Arrow row format.
- **All join types.** Inner, left, right, full, semi and anti joins are supported, plus residual (non-equi) predicates. Outer, semi and anti joins can build on whichever side is smaller. When the preserved side is the small one, semi and anti joins only mark matches in the build table.
- **Join ordering.** Greedy Operator Ordering builds bushy join trees from the SQL join graph. Cardinalities come from Parquet statistics: row counts, min/max ranges (for range-predicate selectivity and integer key NDVs) and sampled NDVs for string columns.

### Aggregation
- **Thread-local pre-aggregation.** When a local table keeps growing without reducing the data (high-cardinality group keys), it switches to radix partitioning. The partitions are then aggregated in parallel, with no merge step.
- **Type-specialized key interning.** Primitive keys live in a SwissTable. Short strings are keyed directly by their 16-byte Utf8View. Composite keys become tuples of dense ids.
- **Dependent-key detection.** Wide keys such as `(c_custkey, c_name, c_address, c_comment, ...)` start in a mode that only hashes the integer column. The other columns are verified per group. If a row breaks the dependency, the groups are re-keyed without changing their ids.

### Optimizer
- **Filters and projections.** Constant folding and expression simplification. Predicate pushdown, including predicates derived from cross-table ORs (TPC-H Q7 and Q19). Projection pruning, and limit/top-k pushdown.
- **Subqueries.** `EXISTS` and `IN` become semi or anti joins. Correlated scalar subqueries become an aggregate plus a left join. That aggregate is restricted with a "magic set" semi-join, computed from the cheapest part of the outer query that supplies the correlation keys.
- **Semi-join reduction and CTEs.** Semi joins are pushed below other joins when that shrinks their inputs. CTEs referenced more than once are materialized once.

### Window functions and recursion
- **Functions.** `row_number`, `rank`, `dense_rank`, `percent_rank`, `cume_dist`, `ntile`, `lag` / `lead` (with defaults and `IGNORE NULLS`), `first_value` / `last_value` / `nth_value`, and every aggregate (with `FILTER`, and `DISTINCT` or `median` over whole partitions).
- **Evaluation.** Each distinct (PARTITION BY, ORDER BY) pair sorts the rows once. Small fixed-width keys are packed with the row index into one `u64` / `u128`, so the sort is a plain parallel integer sort, and partition and peer boundaries are read off the packed bits (the general `ORDER BY` uses the same path). Partitions run in parallel. Moving frames slide an add/remove state along each partition: O(1) per row for sums, counts and variances, amortised O(1) for min / max with a monotonic deque. Large partitions are cut into chunks that run in parallel.
- **Recursive CTEs.** `WITH RECURSIVE` with `UNION ALL` or `UNION` (deduplicated) iterates a physical plan built once over a work table, until no new rows appear. A `LIMIT` above it stops the iteration early.

### Strings and I/O
- **Parquet and strings.** Parquet strings are decoded straight into Arrow `Utf8View` ("German strings"), with no copy. Views are compacted at materialization points, in parallel row ranges, so long pipelines don't accumulate buffer references. Row groups are pruned with min/max statistics, and `count(*)` is answered from metadata.
- **Formats.** Parquet (glob, directory or file) and CSV can be read and written. Results move to and from pyarrow, pandas and polars through the Arrow C stream interface.
- **Object stores.** `s3://` (and `memory://` for tests) go through `object_store` on a small tokio runtime of its own, while scans stay synchronous morsels on the worker pool. Remote footers are fetched concurrently when a table is registered (or on first use, for lazy tables). A scan fetches only the projected column chunks of the row groups that survive pruning, and a prefetcher keeps a window of upcoming row groups in flight under a memory budget, so workers rarely wait on the network. CSV ranges are fetched with a margin and cut at line boundaries. Requests are cancelled with their query. Writes are multipart uploads.

### Clusters on AWS

The Studio's server creates clusters with its own AWS credentials (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, or a dotenv file named by `WORKHOUSE_AWS_ENV_FILE`; in development the repository's `.aws`). On first use it makes a security group that only lets SSH in from the Studio (`WORKHOUSE_STUDIO_CIDRS`, else this machine's public address) and an instance role that reads the engine builds and the buckets the workspace's tables name. Machines run Amazon Linux 2023 with an encrypted volume deleted with them and metadata v2 only. The Studio reaches them with its own SSH key (`WORKHOUSE_STUDIO_DATA`, default `~/.workhouse/studio`), never with EC2 key pairs.

Clusters install the engine of the Studio's version from S3. Publish it once per version (a Linux x86-64-v3 wheel cross-compiled here with zig: `uv pip install ziglang maturin`):

```bash
uv run --env-file .aws python -m workhouse.cloud publish   # build and upload the engine for clusters
uv run --env-file .aws python -m workhouse.cloud verify    # anything of Workhouse left in the account? (exit 1 if so)
uv run --env-file .aws python -m workhouse.cloud cleanup --yes   # terminate every cluster machine, delete the shared resources
```

## Building

The build needs a recent stable Rust toolchain (the crates use edition 2024), Python 3.10 or newer with [uv](https://docs.astral.sh/uv/), and maturin. Studio also needs Node.js 22+ and pnpm.

```bash
uv venv && uv pip install maturin pyarrow
maturin develop --release           # thin LTO; this is the default profile
maturin develop --profile dist      # fat LTO, 1 codegen unit: the benchmark build
uv pip install -e ".[dev]"          # test dependencies (DuckDB, pandas, polars, marimo)
pnpm install                        # Studio
```

`.cargo/config.toml` compiles Windows builds with `-C target-cpu=native`; other targets get a portable CPU level unless `RUSTFLAGS` says otherwise (`workhouse.cloud publish` builds cluster wheels for x86-64-v3).

## Testing and benchmarks

```bash
pytest                                                     # engine (vs DuckDB), query runtime and Studio kernel
pnpm test                                                  # Studio unit tests (vitest)
pnpm e2e                                                   # Studio end-to-end tests (Playwright, system Edge)
python benchmarks/gen_tpch.py 1 benchmarks/data/sf1        # TPC-H data via DuckDB's dbgen
python benchmarks/gen_tpch.py 1 benchmarks/data/sf1_decimal --decimal
python benchmarks/check_tpch.py benchmarks/data/sf1        # 22 queries vs DuckDB
python benchmarks/bench_tpch.py benchmarks/data/sf10 --runs 3 --validate
python benchmarks/profile_query.py benchmarks/data/sf10 10 3   # with WORKHOUSE_PROFILE=1
```

### Environment variables

| Variable | Effect |
|---|---|
| `WORKHOUSE_PROFILE=1` | Print per-pipeline timings, join table and aggregation statistics to stderr |
| `WORKHOUSE_BATCH_SIZE` | Rows per batch (default 8192) |
| `WORKHOUSE_STRING_VIEW=0` | Read Parquet strings as `Utf8` instead of `Utf8View` |
| `WORKHOUSE_AGG_PARTITIONS` | Partition count of radix-mode aggregation (default 4 × threads) |
| `WORKHOUSE_IO_THREADS` | Threads of the object store runtime (default 4) |
| `WORKHOUSE_REMOTE_PREFETCH` | Remote row groups / CSV ranges fetched ahead (default 16; 0 = fetch on demand) |
| `WORKHOUSE_REMOTE_PREFETCH_MB` | Memory budget of fetched, not yet decoded bytes (default 256) |
| `WORKHOUSE_MEMORY_LIMIT` | Memory the engine may hold (`2GB`, `60%`, bytes; default 75% of RAM on Linux): beyond it operators spill to disk |
| `WORKHOUSE_SPILL_DIR` | Where spill files go (default: the system temp folder; clusters use their EBS volume) |
| `WORKHOUSE_RESULT_MEMORY` | Studio kernels: a result larger than this (default `128MB`) is kept on disk, memory-mapped, instead of in memory |

`wh.set_num_threads(n)` sizes the worker pool. It must be called before the first query.

## Limitations

- Regular expressions and `LATERAL` joins are not implemented. `DISTINCT` aggregates and `median` are not supported over moving window frames (only over whole partitions).
- Studio runs for one user: authentication, profiles (users reach the tables their role allows; a compute target gets that role) and shared catalogs are planned for team deployments.
- Correlated subqueries are supported for equality correlations: scalar aggregates, `EXISTS` and `IN`.
- Execution is single-node. Under a memory limit, one partition must still fit in memory: a single join key, aggregation partition or window partition holding most of the data (heavy skew) is not split further. Window functions only spill when all windows of a query share their `PARTITION BY` keys. The pool tracks operator state, not scan buffers or batches in flight.
- Object stores: S3 (and S3-compatible endpoints) only; no local cache of remote data yet.
- CSV reading treats an empty quoted field (`""`) as null, which is a limitation of arrow-csv.
