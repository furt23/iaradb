# Benchmarks

TPC-H (all 22 queries, SF10 and SF100) and ClickBench (43 queries) on Iara, DuckDB, Polars, DataFusion, chDB, Spark and Daft. The engines read the same Parquet files. TPC-H data comes from `tpchgen-cli` (`DECIMAL(15,2)` prices). ClickBench reads a typed copy of `hits.parquet` (see below).

Machine: AWS m7i.4xlarge (16 vCPUs, Xeon 8488C, 64 GB RAM), Amazon Linux 2023, Python 3.12, Iara built with `-C target-cpu=native`. Measured 2026-10-22, all engines in one run. On 2026-10-23 the queries changed below were rerun for every engine on a second instance of the same type (DuckDB as the control ran 2-8% slower there), so each query's row comes from one machine.

Method:

- Every engine runs from Python with its default settings, in its own process. Spark runs in local mode with 75% of the RAM for the driver. DuckDB runs with `parquet_metadata_cache` on.
- Each figure is the median of 3 runs after a warm-up run, or a single run when the warm-up takes over 30 s.
- A query that fails, crashes or runs past the limit (10 min at SF10 and ClickBench, 15 min at SF100) counts as not run.
- TPC-H results are compared with DuckDB's. † marks a wrong result. A difference only past the cent (an engine that keeps the `DECIMAL` scale through a division) counts as correct.
- Sums and geometric means cover all queries, so they are left out (—) for an engine that did not run them all. "Iara faster by" is the geometric mean of the per-query time ratios over the queries both engines ran correctly. Below 1×, the other engine is faster.

## TPC-H SF10

| Engine | Correct | Sum, all 22 | Geomean | Iara faster by |
|---|---:|---:|---:|---:|
| Iara 0.1.0 | 22 | 3.5 s | 130 ms |  |
| DuckDB 1.5.6 | 22 | 5.4 s | 204 ms | 1.57× |
| Polars 2.0.0 | 22 | 6.1 s | 176 ms | 1.35× |
| DataFusion 55.0.0 | 22 | 8.4 s | 291 ms | 2.24× |
| chDB 4.4.0 | 22 | 10.6 s | 367 ms | 2.81× |
| Spark 4.2.0 | 22 | 58.7 s | 1893 ms | 14.53× |
| Daft 0.7.26 | 17 | — | — | 5.06× |

## TPC-H SF100

| Engine | Correct | Sum, all 22 | Geomean | Iara faster by |
|---|---:|---:|---:|---:|
| Iara 0.1.0 | 22 | 36.6 s | 1283 ms |  |
| DuckDB 1.5.6 | 22 | 58.5 s | 2174 ms | 1.69× |
| Polars 2.0.0 | 22 | 69.3 s | 1792 ms | 1.40× |
| DataFusion 55.0.0 | 22 | 94.8 s | 3063 ms | 2.39× |
| chDB 4.4.0 | 22 | 402.3 s | 4747 ms | 3.70× |
| Spark 4.2.0 | 22 | 722.5 s | 22.8 s | 17.77× |
| Daft 0.7.26 | 17 | — | — | 7.12× |

Per query (ms), fastest correct time in bold:

| Query | Iara | DuckDB | Polars | DataFusion | chDB | Spark | Daft |
|:---:|---:|---:|---:|---:|---:|---:|---:|
| Q1 | **2272** | 2666 | 4071 | 4684 | 4432 | 73986 | n/a |
| Q2 | 237 | 613 | **211** | 1061 | 846 | 9594 | 2562 |
| Q3 | **1575** | 2379 | 1970 | 3087 | 49608 | 24461 | 6545 |
| Q4 | **821** | 1456 | 1190 | 1455 | 2475 | 16299 | 5386 |
| Q5 | **2059** | 2718 | 2122 | 4652 | 5970 | 60443 | 6549 |
| Q6 | **800** | 1242 | 892 | 1680 | 2018 | 6356 | 15905 |
| Q7 | **1922** | 2902 | 4326 | 7527 | 5038 | 23569 | 6010 |
| Q8 | **2175** | 3591 | 2236 | 4604 | 7722 | 35711 | n/a |
| Q9 | **4024** | 6177 | 4783 | 7702 | 227234 | 85191 | n/a |
| Q10 | **2297** | 2767 | 2888 | 3912 | 5770 | 18222 | 20143 |
| Q11 | **346** | 500 | 571 | 989 | 781 | 10188 | 3397 |
| Q12 | **814** | 1716 | 999 | 2498 | 4400 | 13275 | 20947 |
| Q13 | **2181** | 3718 | 3624 | 3658 | 4411 | 20354 | 9812 |
| Q14 | **1137** | 1883 | 1259 | 1859 | 2246 | 10033 | n/a |
| Q15 | **1038** | 1795 | 1255 | 3685 | 4242 | 21342 | 7338 |
| Q16 | **465** | 913 | 659 | 572 | 937 | 16048 | 2075 |
| Q17 | 1143 | 3023 | **1070** | 8926 | 4119 | 85657 | 20792 |
| Q18 | 4287 | 4419 | **3722** | 13602 | 4321 | 76466 | 12318 |
| Q19 | **1458** | 2650 | 1802 | 2688 | 4354 | 9476 | 22514 |
| Q20 | **1493** | 2468 | 3089 | 3094 | 3742 | 13110 | 7897 |
| Q21 | **3680** | 7744 | 25971 | 12216 | 56454 | 84577 | n/a |
| Q22 | **413** | 1159 | 595 | 621 | 1214 | 8185 | 1623 |

Polars runs its own DataFrame versions of the queries (`benchmarks/tpch_polars.py`, written like Polars' own PDS-H benchmark); for Q2, Q17 and Q18 they read `partsupp` or `lineitem` once where the SQL plans read them twice. The other engines run the SQL in `benchmarks/tpch_queries.py`, with the spec's constant arithmetic written out as literals (`date '1998-09-02'` for `date '1998-12-01' - interval '90' day`, `between 0.05 and 0.07` for `between 0.06 - 0.01 and 0.06 + 0.01`), as the Polars versions have it. That changed Q1, Q4, Q5, Q6, Q10, Q12, Q14, Q15 and Q20. Before, chDB and Daft computed `0.06 + 0.01` in floating point (0.069999…) and dropped Q6's 0.07 discounts.

Missing results: Daft cannot plan Q1, Q8, Q9 and Q14 on `DECIMAL(15,2)` columns. Its decimal arithmetic does not cap the result precision at 38 digits (Q1, Q9), and a `CASE` cannot mix a decimal with the literal `0` (Q8, Q14). In Q21 its row-group pruning fails to bind a predicate.

## ClickBench

| Engine | Correct | Sum, all 43 | Geomean | Iara faster by |
|---|---:|---:|---:|---:|
| Iara 0.1.0 | 43 | 17.8 s | 105 ms |  |
| DuckDB 1.5.6 | 43 | 26.0 s | 309 ms | 2.93× |
| Polars 2.0.0 | 43 | 28.9 s | 184 ms | 1.75× |
| DataFusion 55.0.0 | 43 | 29.9 s | 226 ms | 2.14× |
| chDB 4.4.0 | 43 | 27.7 s | 328 ms | 3.12× |
| Spark 4.2.0 | 43 | 147.7 s | 2240 ms | 21.27× |
| Daft 0.7.26 | 42 | — | — | 8.15× |

Polars runs DataFrame versions of the queries (`benchmarks/clickbench_polars.py`), each a direct translation of the SQL; its SQL frontend has no `regexp_replace` or `date_trunc` and rejects Q35's repeated group key. On the 40 queries both ran, the two frontends took the same time (21.6 s vs 21.5 s). `polars-sql` still runs the SQL. Q6, Q28 and Q29 name their aggregates (`MIN(EventDate) AS min_date`), since Daft names an unaliased aggregate after its column and two aggregates over one column collide. Daft runs out of memory on Q23.

Where Iara is slower: `REGEXP_REPLACE` (Q28, 2.4 s against chDB's 1.6 s), `GROUP BY URL` (Q33, 1.09× DuckDB) and the `ORDER BY SearchPhrase` top-N (Q25, 1.2× Polars).

## DataFrame workloads

Nineteen DataFrame jobs (`benchmarks/realistic/`) on TPC-H SF100 tables, `hits.parquet` and CSV/NDJSON exports of them. They are written once against the Polars-style API that Iara shares with Polars, so only those two engines run them. Polars uses its streaming engine. Each job runs in a fresh process, best of two runs. Memory is the peak private (anonymous) memory of the process.

| Workload | Iara | Polars (streaming) |
|---|---:|---:|
| csv_groupby | 3.38 s / 171 MB | 6.23 s / 525 MB |
| csv_big_aggregate | 110.7 s / 140 MB | 335.16 s / 234 MB |
| csv_to_parquet | 9.8 s / 2277 MB | 12.49 s / 2151 MB |
| ndjson_groupby | 0.52 s / 105 MB | 0.7 s / 194 MB |
| many_small_files | 1.02 s / 251 MB | 2.12 s / 778 MB |
| feature_engineering_sink | 49.4 s / 5029 MB | 54.18 s / 2725 MB |
| full_sort_sink | 28.22 s / 36836 MB | 24.67 s / 40037 MB |
| to_pandas | 11.32 s / 53035 MB | 40.51 s / 60448 MB |
| top3_per_customer | 4.95 s / 41947 MB | 5.33 s / 28883 MB |
| sessionize | 6.17 s / 7493 MB | 7.92 s / 10133 MB |
| rolling_daily | 0.13 s / 172 MB | 0.13 s / 346 MB |
| url_domains | 3.12 s / 4015 MB | 3.87 s / 2426 MB |
| word_count | 10.5 s / 499 MB | 10.55 s / 1046 MB |
| search_phrase_contains | 0.5 s / 902 MB | 0.46 s / 838 MB |
| string_key_join | 4.21 s / 2551 MB | 4.99 s / 2924 MB |
| dedupe_pairs | 2.63 s / 18193 MB | 3.36 s / 21831 MB |
| wide_filter | 0.13 s / 1073 MB | 0.11 s / 764 MB |
| conditional_aggs | 0.24 s / 203 MB | 0.31 s / 325 MB |
| eager_session | 4.87 s / 38640 MB | 11.56 s / 54713 MB |


Iara uses more memory than Polars on four jobs:

- `top3_per_customer` (42 GB against 29 GB): the window sink keeps the whole table, and ranking it adds a concatenated copy of the key columns, the sort keys and the rank column. Dropping rows that cannot rank in the first 3 as they arrive cut the peak to 23 GB but took 20 s instead of 5 s (every row is looked up in a table of 10M groups), so it is not in.
- `feature_engineering_sink` (5.0 GB against 2.7 GB): the Parquet writer encodes 8 row groups at a time (32 before, 6.5 GB) and drops each column's rows as it encodes them.
- `url_domains` (3.5 to 4.0 GB across runs, against 2.4 GB): the per-group index of a `COUNT(DISTINCT)` state takes 8 bytes a pair for integers and 16 for strings (32 before).
- `wide_filter` (1.1 GB against 0.76 GB): a row group whose column chunks are one page each (DuckDB writes them) is no longer split between threads, which decompressed each page twice (1.5 GB before).

What is left on the last three is mostly memory the allocator (mimalloc) keeps after it was freed, not memory Iara holds: a scan decompresses pages of 10-60 MB at several GB per second. Returning freed memory at once (`MIMALLOC_PURGE_DELAY=0`) with transparent huge pages off brought `wide_filter` to 0.91 GB and `url_domains` to 3.2 GB, at 25% and 20% more time, so the default keeps it. The runs that follow another job pay for the previous one's page cache, so compare a job's times only within the same order.

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
