"""ClickBench benchmark: Iara vs DuckDB vs Polars on hits.parquet.

usage: python benchmarks/bench_clickbench.py <parquet_path> [--runs N] [--engines iara,duckdb,polars] [--queries 0,1,2] [--json out.json]
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from clickbench_queries import QUERIES


def setup_iara(path: str):
    import iara as ia

    ctx = ia.SessionContext()
    ctx.register_parquet("hits", path)
    return lambda q: ctx.sql(QUERIES[q]).collect()


def setup_duckdb(path: str):
    import duckdb

    con = duckdb.connect()
    p = path.replace("\\", "/")
    con.execute(f"CREATE VIEW hits AS SELECT * FROM read_parquet('{p}')")
    return lambda q: con.execute(QUERIES[q]).fetchall()


def setup_polars_sql(path: str):
    import polars as pl

    ctx = pl.SQLContext()
    ctx.register("hits", pl.scan_parquet(path))
    return lambda q: ctx.execute(QUERIES[q]).collect()


def setup_polars_streaming(path: str):
    import polars as pl

    ctx = pl.SQLContext()
    ctx.register("hits", pl.scan_parquet(path))
    return lambda q: ctx.execute(QUERIES[q]).collect(engine="streaming")


SETUP = {
    "iara": setup_iara,
    "duckdb": setup_duckdb,
    "polars": setup_polars_sql,
    "polars-streaming": setup_polars_streaming,
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="Path to hits.parquet or sample.parquet")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--engines", default="iara,duckdb,polars")
    ap.add_argument("--queries", default="")
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    engines = [e.strip() for e in args.engines.split(",") if e.strip()]
    queries = [int(q) for q in args.queries.split(",")] if args.queries else sorted(QUERIES)

    results: dict[str, dict[int, float | None]] = {e: {} for e in engines}

    for e in engines:
        if e not in SETUP:
            print(f"Unknown engine: {e}")
            continue
        try:
            run_query = SETUP[e](args.path)
        except Exception as ex:
            print(f"Failed to setup {e}: {ex}")
            continue

        for q in queries:
            times = []
            err = None
            for r in range(args.runs):
                try:
                    t0 = time.perf_counter()
                    run_query(q)
                    t1 = time.perf_counter()
                    times.append(t1 - t0)
                except Exception as ex:
                    err = str(ex).split("\n")[0][:100]
                    break

            if times:
                med = statistics.median(times)
                results[e][q] = med
                print(f"{e:<18} Q{q:02d} {1000 * med:8.1f}ms")
            else:
                results[e][q] = None
                print(f"{e:<18} Q{q:02d}      n/a  ({err})")

    # Summary table
    print("\nquery", end="")
    for e in engines:
        print(f" {e:>18}", end="")
    print("\n" + "-" * (7 + 19 * len(engines)))

    for q in queries:
        print(f"Q{q:02d} ", end="")
        for e in engines:
            v = results[e].get(q)
            if v is not None:
                print(f" {1000 * v:16.1f}ms", end="")
            else:
                print(f" {'n/a':>18}", end="")
        print()

    print("-" * (7 + 19 * len(engines)))
    common = [q for q in queries if all(results[e].get(q) is not None for e in engines)]
    if common:
        print("total", end="")
        for e in engines:
            tot = sum(results[e][q] for q in common)
            print(f" {1000 * tot:16.1f}ms", end="")
        print(f"   (over {len(common)} queries all engines ran)")

        print("geomean", end="")
        for e in engines:
            vals = [results[e][q] for q in common]
            log_sum = sum(math.log(v) for v in vals)
            geom = math.exp(log_sum / len(vals))
            print(f" {1000 * geom:16.1f}ms", end="")
        print()

    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=2)
        print(f"\nWrote results to {args.json}")


if __name__ == "__main__":
    import math

    main()
