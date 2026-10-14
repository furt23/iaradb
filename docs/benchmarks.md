# Benchmarks

TPC-H (all 22 queries) and ClickBench on Workhouse, DuckDB 1.5.6 and Polars 2.0.0. The engines read the same Parquet files. TPC-H data comes from `tpchgen-cli` (ZSTD, `DECIMAL(15,2)` prices); ClickBench uses the single-file `hits.parquet`. Each figure is the median wall-clock time after a warm-up run, and TPC-H results are checked against DuckDB.

Machine: AWS m7i.4xlarge (16 vCPUs, Xeon 8488C, 64 GB RAM), Amazon Linux 2023, Python 3.12, engine built with `-C target-cpu=native`.

## TPC-H totals

| Scale factor | Workhouse | DuckDB | Polars |
|---|---:|---:|---:|
| SF10, sum of 22 queries | **5.88 s** | 7.69 s | 8.11 s |
| SF10, geometric mean | **224 ms** | 293 ms | 248 ms |
| SF100, sum of 22 queries | **60.6 s** | 82.1 s | 90.0 s |
| SF100, geometric mean | **2.20 s** | 3.07 s | 2.51 s |

## TPC-H SF100 per query (ms)

The fastest time per query is in bold.

| Query | Workhouse | DuckDB | Polars | Query | Workhouse | DuckDB | Polars |
|:---:|---:|---:|---:|:---:|---:|---:|---:|
| Q1 | 3730 | **3542** | 4766 | Q12 | **1109** | 2243 | 1278 |
| Q2 | 735 | 912 | **368** | Q13 | **3250** | 4387 | 4499 |
| Q3 | **2410** | 3350 | 2849 | Q14 | **2032** | 2813 | 2041 |
| Q4 | **1137** | 1998 | 1464 | Q15 | **1995** | 2859 | 2097 |
| Q5 | **3250** | 4148 | 3288 | Q16 | 807 | 1156 | **785** |
| Q6 | **1248** | 1759 | 1270 | Q17 | 3244 | 4495 | **1865** |
| Q7 | **3310** | 4432 | 6857 | Q18 | 5731 | 5585 | **4459** |
| Q8 | 3880 | 5492 | **3848** | Q19 | 2960 | 3789 | **2733** |
| Q9 | **6173** | 8382 | 6617 | Q20 | **2747** | 3747 | 4200 |
| Q10 | **3403** | 3870 | 3771 | Q21 | **6152** | 10885 | 29426 |
| Q11 | **615** | 892 | 733 | Q22 | **637** | 1334 | 779 |

Polars runs its own DataFrame versions of the queries (`benchmarks/tpch_polars.py`); for Q2, Q17 and Q18 they read `partsupp` or `lineitem` once where the SQL plans read them twice.

## ClickBench

Over the 32 queries all three engines ran (the others fail in every engine on this file's integer `EventTime` / `EventDate` columns, or are not supported by Polars):

| | Workhouse | DuckDB | Polars |
|---|---:|---:|---:|
| Sum | **17.6 s** | 18.0 s | 20.3 s |
| Geometric mean | **229 ms** | 338 ms | 259 ms |

Per-query times are printed by `bench_clickbench.py`. Workhouse is slowest on `GROUP BY URL` (Q33, Q34: about 2.1-2.4 s against DuckDB's 1.8 s) and on grouped `COUNT(DISTINCT ...)` (Q8, Q9).

## Reproducing

The scripts are in `benchmarks/`. They need `duckdb` and `polars` (`uv pip install -e ".[dev]"`) and a release build of the engine (see [development.md](development.md)).

Generate the data (with `tpchgen-cli` when it is installed, else DuckDB's dbgen):

```bash
python benchmarks/gen_tpch.py 10 benchmarks/data/sf10
python benchmarks/gen_tpch.py 100 benchmarks/data/sf100
```

Check Workhouse's results against DuckDB:

```bash
python benchmarks/check_tpch.py benchmarks/data/sf10
```

Run the benchmark:

```bash
python benchmarks/bench_tpch.py benchmarks/data/sf10 --runs 3 --validate
python benchmarks/bench_tpch.py benchmarks/data/sf10 --engines workhouse,duckdb --queries 1,3,6
```

Options: `--runs` (default 5), `--engines` (default `workhouse,duckdb,polars`), `--queries` (default all), `--json FILE` to save the timings, `--validate` to compare every engine with DuckDB.

ClickBench, with [hits.parquet](https://datasets.clickhouse.com/hits_compatible/hits.parquet) (14 GB):

```bash
python benchmarks/bench_clickbench.py hits.parquet --runs 2 --engines workhouse,duckdb,polars
```

Profile one query (here Q10 at SF10, 3 runs) with `WORKHOUSE_PROFILE=1`:

```bash
WORKHOUSE_PROFILE=1 python benchmarks/profile_query.py benchmarks/data/sf10 10 3
```

For the fastest build, use `maturin develop --profile dist`.
