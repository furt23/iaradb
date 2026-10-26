# Iara

A parallel query engine for analytics on a single machine. The core is written in Rust on Apache Arrow. It is used from Python, through a lazy DataFrame API and SQL, and from Iara Studio, a web workspace for notebooks and SQL.

```python
import iara
from iara import functions as F

revenue = (
    iara.scan_parquet("data/lineitem")
    .join(iara.scan_parquet("data/orders"), left_on="l_orderkey", right_on="o_orderkey")
    .group_by("o_orderpriority")
    .agg(revenue=(F.col("l_extendedprice") * (1 - F.col("l_discount"))).sum())
    .sort("revenue", descending=True)
    .collect()
)

iara.sql("select k, sum(v) from t group by k", t=arrow_table)   # pyarrow, pandas or polars inputs
```

## What it does

- **Data sources:**
  - Parquet, CSV, JSON and Delta Lake tables;
  - local files or S3-compatible object stores (S3, R2, MinIO);
  - Hive-partitioned datasets.
- **SQL and Python:**
  - SQL in a DuckDB-like dialect, and a Polars-like DataFrame API;
  - joins, window functions, recursive CTEs;
  - lists and structs, schemas;
  - SQL parameters (`:name`, `$1`, `?`), views, `TABLESAMPLE`, `DISTINCT ON`, `SELECT * REPLACE/RENAME/EXCLUDE`;
  - writes: `COPY`, `CREATE TABLE AS`, `INSERT`, and on Delta tables `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`.
- **Execution:**
  - uses every core;
  - spills to disk when a query outgrows its memory limit;
  - streams results without collecting them.
- **Studio:** reactive notebooks stored as plain `.py` files (marimo format), SQL files, a data catalog, query profiles, charts, dashboards, scheduled jobs and on-demand clusters. Sign-in and per-user data grants are optional.

## Install

Wheels will be published to PyPI. Until then, build from source: see [docs/development.md](docs/development.md).

## Performance

Sum of the query times, on the same Parquet files (AWS m7i.4xlarge, 16 vCPUs, 64 GB RAM, measured 2026-10-22). Iara is compared with DuckDB and Polars here; seven engines in total are in the docs:

| Suite | Iara 0.1.0 | DuckDB 1.5.6 | Polars 2.0.0 |
|---|---:|---:|---:|
| TPC-H SF10, all 22 queries | **3.46 s** | 5.37 s | 6.09 s |
| TPC-H SF100, all 22 queries | **36.6 s** | 58.5 s | 69.3 s |
| ClickBench, all 43 queries | **17.8 s** | 26.0 s | 28.9 s |

TPC-H results were checked against DuckDB's. Per-query numbers, the other engines, and how to reproduce them: [docs/benchmarks.md](docs/benchmarks.md).

## Documentation

- [Studio](docs/studio.md)
- [Delta Lake tables](docs/delta.md): writes, MERGE, time travel, maintenance
- [Storage and cloud](docs/storage-and-cloud.md): S3, R2, clusters
- [Architecture](docs/architecture.md)
- [Development](docs/development.md): building, tests, environment variables

## License

Apache-2.0
