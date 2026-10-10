# Workhouse Engine

A parallel, vectorized query engine for structured data: a high-performance Rust core built on Apache Arrow, an expressive Python DataFrame API with lazy execution, a SQL frontend, and Workhouse Studio, an integrated web workspace. Workhouse accelerates single-node analytics workloads—scanning Parquet and CSV, filtering, joining, aggregating, sorting, and streaming results—by driving all available CPU cores through morsel-driven execution pipelines.

```python
import workhouse as wh
from workhouse import col

revenue = (
    wh.scan_parquet("data/lineitem")                       # a file, a directory, or a glob
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

---

## Documentation

The project documentation is organized by activity:

- [**Workhouse Studio**](docs/studio.md): The web workspace for interactive analytics, reactive notebooks in marimo format, data catalog, query plan visualizer, and on-demand compute.
- [**Engine Architecture & Internals**](docs/architecture.md): Morsel-driven push pipelines, L2-cached 8192-row batching, lock-free hash joins, radix aggregations, cost-based optimizer, and out-of-core disk spilling.
- [**Storage & Cloud Infrastructure**](docs/storage-and-cloud.md): S3 and Cloudflare R2 object stores, request cost coalescing and footer caching, and AWS on-demand cluster management.
- [**Performance & Benchmarks**](docs/benchmarks.md): Full 22-query TPC-H benchmark suite (SF1 and SF10) compared against DuckDB and Polars, plus per-query timings and reproducibility scripts.
- [**Building, Testing & Development**](docs/development.md): Development setup, compilation with maturin, test suites, environment variable reference, and engine limitations.

---

## Performance Snapshot

TPC-H benchmark summary comparing Workhouse against DuckDB 1.5.6 and Polars 1.44.2 (running its native lazy API) across the full suite of 22 queries reading the same Parquet files (AMD Ryzen 5 5600G, 16 GB RAM, Windows 11):

| Scale Factor | Workhouse | DuckDB | Polars |
|---|---:|---:|---:|
| **SF1**, sum of 22 queries | **1.02 s** | 1.50 s | 1.99 s |
| SF1, geometric mean | **40.3 ms** | 59.1 ms | 60.5 ms |
| **SF10**, sum of 22 queries | **9.87 s** | 13.94 s | 21.54 s |
| SF10, geometric mean | **359 ms** | 530 ms | 597 ms |

See [**docs/benchmarks.md**](docs/benchmarks.md) for the per-query breakdown at SF10 and instructions on generating data and reproducing the results.

---

## Core Capabilities

### Cloud Object Stores & Hive Datasets
Paths can be local files or object store URLs (`s3://...`). Credentials come from the environment or EC2 instance roles:

```python
wh.scan_parquet("s3://bucket/tpch/lineitem/")                    # a prefix, object, or glob (`**/*.parquet`)
wh.set_storage_options("s3://bucket", {"region": "us-east-1"})  # defaults for every URL under prefix
ctx.register_parquet("t", "s3://bucket/t/", storage_options={"endpoint": "http://localhost:9000"}, lazy=True)
ctx.sql("select count(*) from read_parquet('s3://bucket/t/*.parquet', region => 'us-east-1')")
df.write_parquet("s3://bucket/out/result.parquet")               # multipart upload
```

Partitioned datasets (`sales/year=2024/region=north/part-....parquet`) automatically expose their partition columns, and filters skip files without reading them:

```python
ctx.sql("COPY (select * from orders) TO 's3://bucket/orders' (FORMAT parquet, PARTITION_BY (o_orderyear))")
ctx.set_warehouse("s3://bucket/warehouse")      # where CREATE TABLE writes (else in-memory)
ctx.sql("CREATE OR REPLACE TABLE big_orders PARTITIONED BY (o_orderstatus) AS select * from orders where o_totalprice > 400000")
ctx.sql("INSERT INTO big_orders select * from new_orders where o_totalprice > 400000")
ctx.sql("DROP TABLE big_orders")
lf.sink_parquet("out/sales", partition_by=["year", "region"])
```

### Out-of-Core Processing & Disk Spilling
When queries exceed the configured memory limit, operators (aggregations, joins, sorts, and windows) automatically spill intermediate partitions to disk:

```python
wh.set_memory_limit("4GB")              # or WORKHOUSE_MEMORY_LIMIT (default: 75% of RAM on Linux)
lf.sink_parquet("s3://bucket/out/big.parquet")   # streamed to disk or S3 without collecting into memory
for batch in lf.iter_batches(): ...     # stream pyarrow RecordBatches as produced
wh.memory_usage()                       # inspect {"limit", "used", "peak", "spilled"}
```

### Window Functions & Recursive CTEs
Rich window function support across SQL (`OVER`, `WINDOW w AS (...)`, and `QUALIFY`) and the Python API (`.over()`):

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

### Schemas, Nested Types & JSON
Tables live in schemas (`tpch.lineitem`, or `orders` in `main`), managed with `CREATE SCHEMA`, `DROP SCHEMA [CASCADE]` and `USE`. List and struct columns work in every operator: scans, joins, sorts, windows, aggregates and spill. Nested JSON is read as lists and structs:

```python
ctx.sql("select unnest(string_split(tags, ',')) as tag, count(*) from posts group by tag")
ctx.sql("select user.name, array_agg(item order by ts) from read_ndjson('events.jsonl') group by user.name")
lf.with_columns(col("tags").list.len(), col("user").struct.field("name")).explode("tags")
ctx.sql("select payload ->> '$.order.id' from raw_events")
```

### Functions & Frame Operations
The SQL dialect follows DuckDB and the Python API follows Polars:
- **Strings and regex:** `regexp_like` / `replace` / `extract`, `split_part`, `lpad`, `concat_ws`, `initcap`, `str.contains(regex)`.
- **Dates:** `datediff`, `add_months`, `strptime` / `strftime`, `dt.offset_by`.
- **Aggregates:** `quantile` / `percentile_cont`, `count_if`, `max_by`, `corr`, `array_agg`, `collect_set`.
- **Grouping:** `ROLLUP`, `CUBE`, `GROUPING SETS`.
- **Comparison:** null-safe equality (`<=>`, `IS NOT DISTINCT FROM`).
- **Frame operations:** `fill_null`, `drop_nulls`, `unique(keep=)`, `sample`, `with_row_index`, `describe`, `concat(how="diagonal")`.
- **JSON and CSV:** NDJSON and JSON files are read and written. CSV takes quoting, null values, comment and type-override options, and multi-line quoted fields are split safely in parallel.
- **Overflow:** an integer `sum` that overflows raises an error instead of wrapping.

### Request Costs (S3 / Cloudflare R2)
Each query reports the storage requests it made (`profile()["requests"]`, `wh.storage_requests()`). What keeps the count low:
- consecutive row groups and column chunks are fetched together;
- a footer, and a file up to 512 KB, arrive in one GET;
- footers are cached per file version, and listings for 30 s;
- partitioned tables read only the footers of files that survive pruning.

For R2, set `{"endpoint": "https://<account>.r2.cloudflarestorage.com", "region": "auto"}` as the bucket's storage options. `LazyFrame.analyze()` and `EXPLAIN ANALYZE` give per-operator rows and time.

---

## Workhouse Studio

Workhouse Studio is an integrated browser workspace for the engine:

```bash
pnpm install                                   # web application (Next.js + MUI)
python examples/workspace/setup_data.py        # generate example TPC-H SF0.1 data
workhouse serve examples/workspace             # or: pnpm dev
```

Key features:
- **Reactive Notebooks**: Stored as clean `.py` files using the marimo format. Editing or running a cell triggers dependent cells automatically.
- **Data Catalog**: Explore schemas, inspect column statistics, and manage registered datasets.
- **Visual Plan Profiling**: Inspect pipeline execution graphs, per-operator timings, and memory metrics at `/analyze`.
- **On-Demand Compute**: Start and manage local or AWS EC2 compute clusters with automatic idle termination.
- **Interactive Charts**: Render histograms, bar charts, scatter plots, and area graphs calculated directly in the kernel.

See [**docs/studio.md**](docs/studio.md) for full details on Studio features and workflows.

---

## Building & Quickstart

Workhouse requires Rust (edition 2024), Python 3.10+ with [uv](https://docs.astral.sh/uv/), and Node.js 22+ with pnpm for Studio:

```bash
# Set up Python virtual environment and build Rust extensions
uv venv && uv pip install maturin pyarrow
maturin develop --release           # release build with thin LTO
uv pip install -e ".[dev]"          # install test dependencies

# Run test suites
pytest                              # engine and kernel tests
pnpm test                           # Studio unit tests
```

See [**docs/development.md**](docs/development.md) for detailed build profiles, testing options, and environment variables.
