# Performance & TPC-H Benchmarks

Workhouse includes a comprehensive benchmark suite implementing all 22 standard TPC-H queries, comparing performance across single-node query engines: **Workhouse**, **DuckDB (1.5.6)**, and **Polars (1.44.2)**.

All engines read identical Parquet datasets (ZSTD compression, double-precision numeric columns). Reported figures represent median wall-clock time after a warm-up run, with all output records validated against DuckDB reference results.

---

## Benchmark Results

**Test Machine**:
- CPU: AMD Ryzen 5 5600G (6 cores / 12 threads, 3.9 GHz base / 4.4 GHz boost)
- Memory: 16 GB DDR4 RAM
- Operating System: Windows 11
- Python Runtime: Python 3.12

### Summary Performance (SF1 & SF10)

| Scale Factor | Workhouse | DuckDB | Polars |
|---|---:|---:|---:|
| **SF1**, sum of 22 queries | **1.02 s** | 1.50 s | 1.99 s |
| SF1, geometric mean | **40.3 ms** | 59.1 ms | 60.5 ms |
| **SF10**, sum of 22 queries | **9.87 s** | 13.94 s | 21.54 s |
| SF10, geometric mean | **359 ms** | 530 ms | 597 ms |

---

### Detailed Breakdown at Scale Factor 10 (Per Query)

All measurements are in milliseconds (ms). The fastest time for each query is bolded.

| Query | Workhouse | DuckDB | Polars | Query | Workhouse | DuckDB | Polars |
|:---:|---:|---:|---:|:---:|---:|---:|---:|
| **Q1** | **469** | 635 | 1972 | **Q12** | **205** | 359 | 453 |
| **Q2** | **159** | 200 | 164 | **Q13** | **704** | 924 | 1289 |
| **Q3** | **444** | 558 | 475 | **Q14** | **284** | 472 | 301 |
| **Q4** | **230** | 324 | 630 | **Q15** | **282** | 457 | 302 |
| **Q5** | **593** | 662 | 693 | **Q16** | 168 | 300 | **139** |
| **Q6** | **151** | 277 | 308 | **Q17** | 426 | 631 | **399** |
| **Q7** | **461** | 687 | 540 | **Q18** | **862** | 1030 | 2423 |
| **Q8** | **553** | 827 | 793 | **Q19** | **339** | 601 | 476 |
| **Q9** | **1128** | 1514 | 2708 | **Q20** | **429** | 563 | 1234 |
| **Q10**| 752 | **722** | 791 | **Q21** | **1024** | 1765 | 5107 |
| **Q11**| **95** | 132 | 179 | **Q22** | **110** | 305 | 163 |

---

## Reproducing the Benchmarks

The `benchmarks/` directory includes all scripts needed to generate data, validate correctness, and execute timing runs.

### 1. Generate TPC-H Parquet Data
Generate test datasets using DuckDB's dbgen integration:
```bash
# Generate SF1 (Scale Factor 1)
python benchmarks/gen_tpch.py 1 benchmarks/data/sf1

# Generate SF1 with decimal types
python benchmarks/gen_tpch.py 1 benchmarks/data/sf1_decimal --decimal

# Generate SF10 (Scale Factor 10)
python benchmarks/gen_tpch.py 10 benchmarks/data/sf10
```

### 2. Verify Result Correctness
Compare Workhouse outputs query-by-query against DuckDB:
```bash
python benchmarks/check_tpch.py benchmarks/data/sf1
```

### 3. Run Benchmark Suite
Run the full benchmark across all engines with multiple iterations:
```bash
python benchmarks/bench_tpch.py benchmarks/data/sf10 --runs 3 --validate
```

To benchmark specific queries or engines:
```bash
python benchmarks/bench_tpch.py benchmarks/data/sf10 --engines workhouse,duckdb --queries 1,3,6
```

### 4. Query Profiling
Inspect detailed per-operator timings, pipeline metrics, and hash table statistics:
```bash
# Profile Query 10 at SF10 for 3 runs with engine profiling enabled
WORKHOUSE_PROFILE=1 python benchmarks/profile_query.py benchmarks/data/sf10 10 3
```
