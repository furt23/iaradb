# Benchmarks

TPC-H (all 22 queries, SF10 and SF100) and ClickBench (43 queries) on Iara, DuckDB, Polars, DataFusion, chDB, Spark and Daft. The engines read the same Parquet files. TPC-H data comes from `tpchgen-cli` (`DECIMAL(15,2)` prices). ClickBench reads a typed copy of `hits.parquet` (see below).

Machine: AWS m7i.4xlarge (16 vCPUs, Xeon 8488C, 64 GB RAM), Amazon Linux 2023, Python 3.12, Iara built with `-C target-cpu=native`. Measured 2026-10-18; Iara was re-measured on the same instance type after later engine changes, the other engines are from the first run.

Method:

- Every engine runs from Python with its default settings, in its own process. Spark runs in local mode with 75% of the RAM for the driver. DuckDB runs with `parquet_metadata_cache` on.
- Each figure is the median of 3 runs after a warm-up run, or a single run when the warm-up takes over 30 s.
- A query that fails, crashes or runs past the limit (10 min at SF10 and ClickBench, 15 min at SF100) counts as not run.
- TPC-H results are compared with DuckDB's. † marks a wrong result. A difference only past the cent (an engine that keeps the `DECIMAL` scale through a division) counts as correct.
- Sums and geometric means cover all queries, so they are left out (—) for an engine that did not run them all. "Iara faster by" is the geometric mean of the per-query time ratios over the queries both engines ran correctly. Below 1×, the other engine is faster.

## TPC-H SF10

| Engine | Correct | Sum, all 22 | Geomean | Iara faster by |
|---|---:|---:|---:|---:|
| Iara 0.1.0 | 22 | 4.1 s | 157 ms |  |
| DuckDB 1.5.6 | 22 | 5.4 s | 206 ms | 1.31× |
| Polars 2.0.0 | 22 | 6.1 s | 177 ms | 1.13× |
| DataFusion 55.0.0 | 22 | 8.4 s | 294 ms | 1.87× |
| chDB 4.4.0 | 21 | 10.8 s † | 375 ms | 2.41× |
| Spark 4.2.0 | 22 | 58.7 s | 1898 ms | 12.10× |
| Daft 0.7.26 | 16 | — | — | 3.76× |

## TPC-H SF100

| Engine | Correct | Sum, all 22 | Geomean | Iara faster by |
|---|---:|---:|---:|---:|
| Iara 0.1.0 | 22 | 41.1 s | 1453 ms |  |
| DuckDB 1.5.6 | 22 | 59.2 s | 2200 ms | 1.51× |
| Polars 2.0.0 | 22 | 69.3 s | 1783 ms | 1.23× |
| DataFusion 55.0.0 | 22 | 95.0 s | 3070 ms | 2.11× |
| chDB 4.4.0 | 21 | 398.8 s † | 4742 ms | 3.33× |
| Spark 4.2.0 | 22 | 733.7 s | 22.9 s | 15.79× |
| Daft 0.7.26 | 16 | — | — | 5.70× |

Per query (ms), fastest correct time in bold:

| Query | Iara | DuckDB | Polars | DataFusion | chDB | Spark | Daft |
|:---:|---:|---:|---:|---:|---:|---:|---:|
| Q1 | **2472** | 2608 | 3986 | 4648 | 4417 | 71477 | n/a |
| Q2 | 300 | 623 | **213** | 1071 | 859 | 10071 | 2579 |
| Q3 | **1770** | 2511 | 2012 | 3128 | 49965 | 23933 | 6631 |
| Q4 | **864** | 1527 | 1157 | 1470 | 2506 | 16121 | 5038 |
| Q5 | 2101 | 2940 | **2008** | 4587 | 5123 | 61872 | 6439 |
| Q6 | **860** | 1151 | 869 | 1667 | 1885 † | 6261 | 14032 † |
| Q7 | **2284** | 2984 | 4379 | 7568 | 5205 | 23581 | 6038 |
| Q8 | 2342 | 3697 | **2261** | 4658 | 7848 | 35100 | n/a |
| Q9 | **4369** | 6348 | 4803 | 7773 | 224636 | 90633 | n/a |
| Q10 | 3042 | 2861 | **2828** | 3854 | 5753 | 19902 | 19579 |
| Q11 | **392** | 488 | 568 | 991 | 805 | 10084 | 3372 |
| Q12 | **860** | 1661 | 977 | 2490 | 4464 | 13091 | 20401 |
| Q13 | **2359** | 3714 | 3669 | 3722 | 4429 | 20541 | 9892 |
| Q14 | **1143** | 1988 | 1226 | 1857 | 2254 | 9723 | n/a |
| Q15 | **1144** | 1780 | 1222 | 3578 | 4259 | 20470 | 6654 |
| Q16 | 639 | 915 | 652 | **575** | 953 | 16028 | 2075 |
| Q17 | 1353 | 3034 | **1086** | 8914 | 4182 | 88996 | 20908 |
| Q18 | 4597 | 4421 | **3771** | 13693 | 4337 | 76625 | 12445 |
| Q19 | 2084 | 2654 | **1844** | 2727 | 4450 | 9745 | 22538 |
| Q20 | **1580** | 2442 | 3032 | 3067 | 3822 | 12794 | 7676 |
| Q21 | **4045** | 7648 | 26150 | 12274 | 55422 | 88510 | n/a |
| Q22 | **460** | 1249 | 611 | 642 | 1231 | 8136 | 1638 |

Polars runs its own DataFrame versions of the queries (`benchmarks/tpch_polars.py`); for Q2, Q17 and Q18 they read `partsupp` or `lineitem` once where the SQL plans read them twice. The other engines run the SQL in `benchmarks/tpch_queries.py`.

Wrong or missing results:

- chDB and Daft return a wrong Q6: they evaluate `between 0.06 - 0.01 and 0.06 + 0.01` in floating point, which drops the rows with a 0.07 discount.
- Daft cannot plan Q1, Q8, Q9 and Q14 (in Q1 the `DECIMAL` product exceeds 38 digits) or the correlated subquery in Q21.

## ClickBench

| Engine | Correct | Sum, all 43 | Geomean | Iara faster by |
|---|---:|---:|---:|---:|
| Iara 0.1.0 | 43 | 23.4 s | 149 ms |  |
| DuckDB 1.5.6 | 43 | 26.3 s | 311 ms | 2.09× |
| Polars 2.0.0 | 40 | — | — | 1.23× |
| DataFusion 55.0.0 | 43 | 30.1 s | 227 ms | 1.52× |
| chDB 4.4.0 | 43 | 27.7 s | 329 ms | 2.21× |
| Spark 4.2.0 | 43 | 152.7 s | 2315 ms | 15.54× |
| Daft 0.7.26 | 39 | — | — | 5.17× |

Polars SQL has no `regexp_replace` or `date_trunc` and rejects Q35's repeated group key. Daft cannot plan Q6, Q28 and Q29 and ran out of memory on Q23.

Where Iara is slower: grouped `COUNT(DISTINCT ...)` (Q8, Q9: 1.6-1.8× DuckDB), wide `GROUP BY`s (Q16-Q18, Q32: 1.5-2.5×) and `REGEXP_REPLACE` (Q28, 2.9 s against chDB's 1.6 s).

## DataFrame workloads

Nineteen DataFrame jobs (`benchmarks/realistic/`) on TPC-H SF100 tables, `hits.parquet` and CSV/NDJSON exports of them. They are written once against the Polars-style API that Iara shares with Polars, so only those two engines run them. Polars uses its streaming engine. Each job runs in a fresh process, best of two runs. Memory is the peak private (anonymous) memory of the process.

| Workload | Iara | Polars (streaming) |
|---|---:|---:|
| csv_groupby | 3.38 s / 171 MB | 6.23 s / 525 MB |
| csv_big_aggregate | 110.7 s / 140 MB | 335.16 s / 234 MB |
| csv_to_parquet | 14.17 s / 10436 MB | 12.85 s / 1228 MB |
| ndjson_groupby | 9.36 s / 323 MB | 8.08 s / 616 MB |
| many_small_files | 1.02 s / 251 MB | 2.12 s / 778 MB |
| feature_engineering_sink | 78.68 s / 7067 MB | 55.03 s / 2707 MB |
| full_sort_sink | 28.22 s / 36836 MB | 24.67 s / 40037 MB |
| to_pandas | out of memory | 45.7 s / 60162 MB |
| top3_per_customer | 9.07 s / 40401 MB | 5.03 s / 28463 MB |
| sessionize | 6.17 s / 7493 MB | 7.92 s / 10133 MB |
| rolling_daily | 0.17 s / 143 MB | 0.11 s / 371 MB |
| url_domains | 3.87 s / 3232 MB | 4.78 s / 9625 MB |
| word_count | 12.06 s / 485 MB | 13.7 s / 1306 MB |
| search_phrase_contains | 0.74 s / 359 MB | 0.73 s / 862 MB |
| string_key_join | 4.08 s / 10051 MB | 4.99 s / 2924 MB |
| dedupe_pairs | 3.34 s / 20214 MB | 3.12 s / 20881 MB |
| wide_filter | 0.18 s / 1589 MB | 0.14 s / 775 MB |
| conditional_aggs | 0.48 s / 171 MB | 0.3 s / 416 MB |
| eager_session | 4.87 s / 38640 MB | 11.56 s / 54713 MB |


Iara runs out of memory on `to_pandas` and is slower on `top3_per_customer` (a ranked window over 15M groups) and `feature_engineering_sink`. The runs that follow another job pay for the previous one's page cache, so compare a job's times only within the same order.

## Reproducing

The scripts are in `benchmarks/`. Install the engines with `uv pip install -e ".[bench]"` (Spark also needs Java 17+, and chDB has no Windows wheels) and a release build of Iara (see [development.md](development.md)).

Generate the data (with `tpchgen-cli` when it is installed, else DuckDB's dbgen) and the typed ClickBench file:

```bash
python benchmarks/gen_tpch.py 10 benchmarks/data/sf10
python benchmarks/gen_tpch.py 100 benchmarks/data/sf100
python benchmarks/prepare_hits.py hits.parquet hits_typed.parquet
```

[hits.parquet](https://datasets.clickhouse.com/hits_compatible/hits.parquet) is 14 GB.

Run the benchmarks:

```bash
python benchmarks/bench_tpch.py benchmarks/data/sf10 --validate --json tpch_sf10.json
python benchmarks/bench_tpch.py benchmarks/data/sf10 --engines iara,duckdb --queries 1,3,6
python benchmarks/bench_clickbench.py hits_typed.parquet --json clickbench.json
```

Options: `--engines` (default: all seven), `--queries` (default all), `--runs` (default 3), `--timeout` (seconds per query, default 600), `--validate` to compare every engine with DuckDB, `--json FILE` to save the timings. On Linux, point `TMPDIR` at a disk: `/tmp` is often a RAM-backed tmpfs, and spill files there count against memory.

`--json` merges into an existing file, replacing only the engines that ran. To measure a change in Iara against an earlier round, run `--engines iara,duckdb --json <that round's file>` on the same machine type; DuckDB serves as the control for machine-to-machine variance.

`python benchmarks/site_data.py <results dir>` turns a round's JSON files into the landing site's data (`apps/site/src/data/benchmarks.json`).

Check Iara's TPC-H results against DuckDB:

```bash
python benchmarks/check_tpch.py benchmarks/data/sf10
```

Profile one query (here Q10 at SF10, 3 runs) with `IARA_PROFILE=1`:

```bash
IARA_PROFILE=1 python benchmarks/profile_query.py benchmarks/data/sf10 10 3
```

For the fastest build, use `maturin develop --profile dist`.
