# Benchmarks

All 22 TPC-H queries on Workhouse, DuckDB 1.5.6 and Polars 1.44.2. The engines read the same Parquet files (ZSTD, double-precision numerics). Each figure is the median wall-clock time after a warm-up run, and results are checked against DuckDB.

Machine: AMD Ryzen 5 5600G (6 cores, 12 threads), 16 GB RAM, Windows 11, Python 3.12.

## Totals

| Scale factor | Workhouse | DuckDB | Polars |
|---|---:|---:|---:|
| SF1, sum of 22 queries | **1.02 s** | 1.50 s | 1.99 s |
| SF1, geometric mean | **40.3 ms** | 59.1 ms | 60.5 ms |
| SF10, sum of 22 queries | **9.87 s** | 13.94 s | 21.54 s |
| SF10, geometric mean | **359 ms** | 530 ms | 597 ms |

## SF10 per query (ms)

The fastest time per query is in bold.

| Query | Workhouse | DuckDB | Polars | Query | Workhouse | DuckDB | Polars |
|:---:|---:|---:|---:|:---:|---:|---:|---:|
| Q1 | **469** | 635 | 1972 | Q12 | **205** | 359 | 453 |
| Q2 | **159** | 200 | 164 | Q13 | **704** | 924 | 1289 |
| Q3 | **444** | 558 | 475 | Q14 | **284** | 472 | 301 |
| Q4 | **230** | 324 | 630 | Q15 | **282** | 457 | 302 |
| Q5 | **593** | 662 | 693 | Q16 | 168 | 300 | **139** |
| Q6 | **151** | 277 | 308 | Q17 | 426 | 631 | **399** |
| Q7 | **461** | 687 | 540 | Q18 | **862** | 1030 | 2423 |
| Q8 | **553** | 827 | 793 | Q19 | **339** | 601 | 476 |
| Q9 | **1128** | 1514 | 2708 | Q20 | **429** | 563 | 1234 |
| Q10 | 752 | **722** | 791 | Q21 | **1024** | 1765 | 5107 |
| Q11 | **95** | 132 | 179 | Q22 | **110** | 305 | 163 |

## Reproducing

The scripts are in `benchmarks/`. They need `duckdb` and `polars` (`uv pip install -e ".[dev]"`) and a release build of the engine (see [development.md](development.md)).

Generate the data:

```bash
python benchmarks/gen_tpch.py 1 benchmarks/data/sf1
python benchmarks/gen_tpch.py 10 benchmarks/data/sf10
python benchmarks/gen_tpch.py 1 benchmarks/data/sf1_decimal --decimal   # keep DECIMAL(15,2)
```

Check Workhouse's results against DuckDB:

```bash
python benchmarks/check_tpch.py benchmarks/data/sf1
```

Run the benchmark:

```bash
python benchmarks/bench_tpch.py benchmarks/data/sf10 --runs 3 --validate
python benchmarks/bench_tpch.py benchmarks/data/sf10 --engines workhouse,duckdb --queries 1,3,6
```

Options: `--runs` (default 5), `--engines` (default `workhouse,duckdb,polars`), `--queries` (default all), `--json FILE` to save the timings, `--validate` to compare every engine with DuckDB.

Profile one query (here Q10 at SF10, 3 runs) with `WORKHOUSE_PROFILE=1`:

```bash
WORKHOUSE_PROFILE=1 python benchmarks/profile_query.py benchmarks/data/sf10 10 3
```

For the fastest build, use `maturin develop --profile dist`.
