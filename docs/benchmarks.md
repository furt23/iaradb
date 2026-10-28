# Benchmarks

TPC-H (all 22 queries, SF10 and SF100) and ClickBench (43 queries) on Iara, DuckDB, Polars, DataFusion, chDB, Spark and Daft. The engines read the same Parquet files. TPC-H data comes from `tpchgen-cli` (`DECIMAL(15,2)` prices). ClickBench reads a typed copy of `hits.parquet` (see below).

Machine: AWS m7i.4xlarge (16 vCPUs, Xeon 8488C, 64 GB RAM), Amazon Linux 2023, Python 3.12, Iara built with `-C target-cpu=native`. Measured 2026-10-22, all engines in one run. On 2026-10-23 the queries changed below were rerun for every engine on a second instance of the same type (DuckDB as the control ran 2-8% slower there), so each query's row comes from one machine. Iara and DuckDB (the control) were rerun on 2026-10-28 on a third instance, after Iara's allocator on Linux changed from mimalloc to jemalloc (see [architecture.md](architecture.md#memory-and-spilling)); DuckDB ran 3-6% slower there than on 2026-10-22, and Iara's figures carry that too.

Method:

- Every engine runs from Python with its default settings, in its own process. Spark runs in local mode with 75% of the RAM for the driver. DuckDB runs with `parquet_metadata_cache` on.
- Each figure is the median of 3 runs after a warm-up run, or a single run when the warm-up takes over 30 s.
- A query that fails, crashes or runs past the limit (10 min at SF10 and ClickBench, 15 min at SF100) counts as not run.
- TPC-H results are compared with DuckDB's. † marks a wrong result. A difference only past the cent (an engine that keeps the `DECIMAL` scale through a division) counts as correct.
- Sums and geometric means cover all queries, so they are left out (—) for an engine that did not run them all. "Iara faster by" is the geometric mean of the per-query time ratios over the queries both engines ran correctly. Below 1×, the other engine is faster.

## TPC-H SF10

| Engine | Correct | Sum, all 22 | Geomean | Iara faster by |
|---|---:|---:|---:|---:|
| Iara 0.1.0 | 22 | 3.9 s | 145 ms |  |
| DuckDB 1.5.6 | 22 | 5.6 s | 209 ms | 1.44× |
| Polars 2.0.0 | 22 | 6.1 s | 176 ms | 1.22× |
| DataFusion 55.0.0 | 22 | 8.4 s | 291 ms | 2.01× |
| chDB 4.4.0 | 22 | 10.6 s | 367 ms | 2.53× |
| Spark 4.2.0 | 22 | 58.7 s | 1893 ms | 13.06× |
| Daft 0.7.26 | 17 | — | — | 4.55× |

## TPC-H SF100

| Engine | Correct | Sum, all 22 | Geomean | Iara faster by |
|---|---:|---:|---:|---:|
| Iara 0.1.0 | 22 | 41.6 s | 1432 ms |  |
| DuckDB 1.5.6 | 22 | 61.8 s | 2289 ms | 1.60× |
| Polars 2.0.0 | 22 | 69.3 s | 1792 ms | 1.25× |
| DataFusion 55.0.0 | 22 | 94.8 s | 3063 ms | 2.14× |
| chDB 4.4.0 | 22 | 402.3 s | 4747 ms | 3.31× |
| Spark 4.2.0 | 22 | 722.5 s | 22.8 s | 15.92× |
| Daft 0.7.26 | 17 | — | — | 6.38× |

Per query (ms), fastest correct time in bold:

| Query | Iara | DuckDB | Polars | DataFusion | chDB | Spark | Daft |
|:---:|---:|---:|---:|---:|---:|---:|---:|
| Q1 | **2425** | 2800 | 4071 | 4684 | 4432 | 73986 | n/a |
| Q2 | 267 | 620 | **211** | 1061 | 846 | 9594 | 2562 |
| Q3 | **1868** | 2557 | 1970 | 3087 | 49609 | 24461 | 6545 |
| Q4 | **919** | 1554 | 1191 | 1455 | 2475 | 16299 | 5386 |
| Q5 | 2239 | 2804 | **2122** | 4652 | 5970 | 60443 | 6549 |
| Q6 | **854** | 1296 | 892 | 1680 | 2018 | 6355 | 15905 |
| Q7 | **2218** | 3063 | 4326 | 7527 | 5038 | 23569 | 6010 |
| Q8 | 2346 | 3803 | **2236** | 4604 | 7722 | 35711 | n/a |
| Q9 | 4826 | 6529 | **4783** | 7703 | 227234 | 85191 | n/a |
| Q10 | **2653** | 3013 | 2888 | 3912 | 5770 | 18222 | 20143 |
| Q11 | **377** | 501 | 571 | 989 | 781 | 10188 | 3397 |
| Q12 | **882** | 1802 | 999 | 2498 | 4400 | 13275 | 20947 |
| Q13 | **2708** | 3786 | 3624 | 3658 | 4411 | 20354 | 9812 |
| Q14 | **1217** | 1826 | 1259 | 1859 | 2246 | 10033 | n/a |
| Q15 | **1118** | 1854 | 1255 | 3685 | 4242 | 21342 | 7338 |
| Q16 | **525** | 984 | 659 | 572 | 937 | 16048 | 2075 |
| Q17 | 1255 | 3231 | **1070** | 8926 | 4119 | 85657 | 20792 |
| Q18 | 4989 | 4889 | **3722** | 13602 | 4321 | 76466 | 12318 |
| Q19 | **1554** | 2825 | 1802 | 2688 | 4354 | 9475 | 22514 |
| Q20 | **1558** | 2643 | 3089 | 3094 | 3742 | 13110 | 7897 |
| Q21 | **4334** | 8104 | 25971 | 12216 | 56454 | 84577 | n/a |
| Q22 | **455** | 1306 | 595 | 621 | 1214 | 8185 | 1623 |

Polars runs its own DataFrame versions of the queries (`benchmarks/tpch_polars.py`, written like Polars' own PDS-H benchmark); for Q2, Q17 and Q18 they read `partsupp` or `lineitem` once where the SQL plans read them twice. The other engines run the SQL in `benchmarks/tpch_queries.py`, with the spec's constant arithmetic written out as literals (`date '1998-09-02'` for `date '1998-12-01' - interval '90' day`, `between 0.05 and 0.07` for `between 0.06 - 0.01 and 0.06 + 0.01`), as the Polars versions have it. That changed Q1, Q4, Q5, Q6, Q10, Q12, Q14, Q15 and Q20. Before, chDB and Daft computed `0.06 + 0.01` in floating point (0.069999…) and dropped Q6's 0.07 discounts.

Missing results: Daft cannot plan Q1, Q8, Q9 and Q14 on `DECIMAL(15,2)` columns. Its decimal arithmetic does not cap the result precision at 38 digits (Q1, Q9), and a `CASE` cannot mix a decimal with the literal `0` (Q8, Q14). In Q21 its row-group pruning fails to bind a predicate.

## ClickBench

| Engine | Correct | Sum, all 43 | Geomean | Iara faster by |
|---|---:|---:|---:|---:|
| Iara 0.1.0 | 43 | 21.2 s | 124 ms |  |
| DuckDB 1.5.6 | 43 | 27.3 s | 320 ms | 2.57× |
| Polars 2.0.0 | 43 | 28.9 s | 184 ms | 1.48× |
| DataFusion 55.0.0 | 43 | 29.9 s | 226 ms | 1.82× |
| chDB 4.4.0 | 43 | 27.7 s | 328 ms | 2.64× |
| Spark 4.2.0 | 43 | 147.7 s | 2240 ms | 18.02× |
| Daft 0.7.26 | 42 | — | — | 7.01× |

Polars runs DataFrame versions of the queries (`benchmarks/clickbench_polars.py`), each a direct translation of the SQL; its SQL frontend has no `regexp_replace` or `date_trunc` and rejects Q35's repeated group key. On the 40 queries both ran, the two frontends took the same time (21.6 s vs 21.5 s). `polars-sql` still runs the SQL. Q6, Q28 and Q29 name their aggregates (`MIN(EventDate) AS min_date`), since Daft names an unaliased aggregate after its column and two aggregates over one column collide. Daft runs out of memory on Q23.

Where another engine is more than 10% faster: `REGEXP_REPLACE` (Q28, 1.58× chDB), Q22, Q25 and Q39 (1.37×, 1.33× and 1.60× Polars; Q39 takes 68 ms), `GROUP BY URL` (Q33 and Q34, 1.28× and 1.26× DuckDB), Q18 (1.24× DuckDB), Q32 (1.23× DataFusion), and Q4 and Q23 (1.13× Polars and DuckDB). Most of these build large hash tables, whose memory jemalloc gives back to the system after each run, so every run faults it in again.

## DataFrame workloads

Nineteen DataFrame jobs (`benchmarks/realistic/`) on TPC-H SF100 tables, `hits.parquet` and CSV/NDJSON exports of them. They are written once against the Polars-style API that Iara shares with Polars, so only those two engines run them. Polars uses its streaming engine. Each job runs in a fresh process, best of two runs. Memory is the peak private (anonymous) memory of the process. Measured 2026-10-28 with Polars 2.0.0, except `csv_groupby`, `csv_big_aggregate`, `csv_to_parquet`, `many_small_files` and `sessionize`, measured before Iara's allocator on Linux changed to jemalloc.

| Workload | Iara | Polars (streaming) |
|---|---:|---:|
| csv_groupby | 3.38 s / 171 MB | 6.23 s / 525 MB |
| csv_big_aggregate | 110.7 s / 140 MB | 335.16 s / 234 MB |
| csv_to_parquet | 9.8 s / 2277 MB | 12.49 s / 2151 MB |
| ndjson_groupby | 0.56 s / 43 MB | 0.81 s / 242 MB |
| many_small_files | 1.02 s / 251 MB | 2.12 s / 778 MB |
| feature_engineering_sink | 56.38 s / 4012 MB | 59.29 s / 3198 MB |
| full_sort_sink | 20.46 s / 31765 MB | 31.3 s / 40383 MB |
| to_pandas | 19.92 s / 46627 MB | 41.56 s / 60149 MB |
| top3_per_customer | 5.52 s / 33236 MB | 5.1 s / 29168 MB |
| sessionize | 6.17 s / 7493 MB | 7.92 s / 10133 MB |
| rolling_daily | 0.13 s / 76 MB | 0.13 s / 356 MB |
| url_domains | 3.72 s / 3203 MB | 4.98 s / 9322 MB |
| word_count | 11.78 s / 143 MB | 14.19 s / 1291 MB |
| search_phrase_contains | 0.65 s / 304 MB | 0.63 s / 1082 MB |
| string_key_join | 5.36 s / 1962 MB | 5.09 s / 2908 MB |
| dedupe_pairs | 3.51 s / 16766 MB | 3.26 s / 18980 MB |
| wide_filter | 0.18 s / 845 MB | 0.11 s / 766 MB |
| conditional_aggs | 0.24 s / 90 MB | 0.33 s / 324 MB |
| eager_session | 6.48 s / 33994 MB | 12.26 s / 54844 MB |


Iara uses more memory than Polars on three jobs:

- `top3_per_customer` (33.2 GB against 29.2 GB): the window keeps its whole input (25 GB), and sorting it adds the packed sort keys and their sorted copy, 16 bytes a row each. Dropping rows that cannot rank in the first 3 as they arrive cut the peak to 23 GB but took 20 s instead of 5 s (every row is looked up in a table of 10M groups), so it is not in.
- `feature_engineering_sink` (4.0 GB against 3.2 GB): the data Iara holds peaks at 2.7 GB; the rest is memory the allocator keeps between the scan's and the Parquet writer's buffers.
- `wide_filter` (845 MB against 766 MB): the data held peaks at 691 MB.

On Linux and macOS the allocator is jemalloc, as in Polars and DuckDB. On the same machine with mimalloc, Iara's allocator before, the jobs held 8-28% more (`url_domains` 3.8 GB, `feature_engineering_sink` 4.8 GB, `top3_per_customer` 39.2 GB, `eager_session` 40 GB) and `word_count` 3.4 times as much (491 MB). Time moved both ways. Run alternately in one order, best of two: `to_pandas` took 17.8 s with mimalloc and 12.2 s with jemalloc, `word_count` 16.4 and 12.4 s, `eager_session` 7.2 and 6.5 s, while `string_key_join` (4.2 and 5.3 s) and `dedupe_pairs` (3.0 and 3.8 s) were about 25% slower with jemalloc, ClickBench 18% and TPC-H SF100 8%. The slower ones build large hash tables: jemalloc gives blocks of 8 MB and more back to the system as they are freed, and the next run faults that memory in again. Keeping those blocks (`_RJEM_MALLOC_CONF=oversize_threshold:0`) brings ClickBench back to within 3% of mimalloc but loses most of the memory saved.

The runs that follow another job pay for the previous one's page cache, so compare a job's times only within the same order.

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
