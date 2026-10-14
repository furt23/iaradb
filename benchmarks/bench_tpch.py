"""TPC-H benchmark: Workhouse vs DuckDB vs Polars (all reading the same Parquet files).

usage: python benchmarks/bench_tpch.py <data_dir> [--runs N] [--engines workhouse,duckdb,polars] [--queries 1,2,3]
                                       [--json out.json]
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tests"))
from tpch_queries import QUERIES, TABLES  # noqa: E402


# each setup returns run(query_number) -> pyarrow.Table


def setup_workhouse(data: str):
    import workhouse as wh

    ctx = wh.SessionContext()
    for t in TABLES:
        ctx.register_parquet(t, os.path.join(data, t))
    return lambda q: ctx.sql(QUERIES[q]).collect().to_arrow()


def setup_duckdb(data: str):
    import duckdb

    con = duckdb.connect()
    for t in TABLES:
        path = os.path.join(data, t).replace("\\", "/")
        con.execute(f"CREATE VIEW {t} AS SELECT * FROM read_parquet('{path}/*.parquet')")

    def run(q):
        r = con.execute(QUERIES[q]).arrow()
        return r.read_all() if hasattr(r, "read_all") else r

    return run


def setup_polars(data: str):
    from tpch_polars import QUERIES as PQ
    from tpch_polars import tables

    t = tables(data)
    return lambda q: PQ[q](t).collect().to_arrow()


def setup_polars_streaming(data: str):
    from tpch_polars import QUERIES as PQ
    from tpch_polars import tables

    t = tables(data)
    return lambda q: PQ[q](t).collect(engine="streaming").to_arrow()


def setup_polars_sql(data: str):
    import polars as pl

    ctx = pl.SQLContext()
    for t in TABLES:
        ctx.register(t, pl.scan_parquet(os.path.join(data, t, "*.parquet")))
    return lambda q: ctx.execute(QUERIES[q]).collect().to_arrow()


SETUP = {
    "workhouse": setup_workhouse,
    "duckdb": setup_duckdb,
    "polars": setup_polars,
    "polars-streaming": setup_polars_streaming,
    "polars-sql": setup_polars_sql,
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--engines", default="workhouse,duckdb,polars")
    ap.add_argument("--queries", default="")
    ap.add_argument("--json", default="")
    ap.add_argument("--validate", action="store_true", help="check every engine's results against DuckDB")
    args = ap.parse_args()
    engines = args.engines.split(",")
    queries = [int(q) for q in args.queries.split(",")] if args.queries else sorted(QUERIES)

    reference = {}
    if args.validate:
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tests"))
        ref_run = setup_duckdb(args.data)
        reference = {q: ref_run(q) for q in queries}
    from compare import diff  # noqa: E402

    results: dict[str, dict[int, float | None]] = {e: {} for e in engines}
    for e in engines:
        run = SETUP[e](args.data)
        for q in queries:
            try:
                out = run(q)  # warm-up
                if args.validate:
                    d = diff(out, reference[q], ordered=True, rtol=1e-6)
                    if d is not None:
                        print(f"  {e} Q{q}: WRONG RESULT: {d}", file=sys.stderr)
                times = []
                for _ in range(args.runs):
                    t0 = time.perf_counter()
                    run(q)
                    times.append(time.perf_counter() - t0)
                results[e][q] = statistics.median(times)
            except Exception as ex:  # noqa: BLE001
                results[e][q] = None
                print(f"  {e} Q{q}: {type(ex).__name__}: {str(ex).splitlines()[0][:100]}", file=sys.stderr)
            v = results[e][q]
            print(f"{e:<10} Q{q:02d} {'   n/a' if v is None else f'{1000 * v:8.1f}ms'}", file=sys.stderr, flush=True)

    # summary table
    header = "query  " + "".join(f"{e:>12}" for e in engines)
    print(header)
    print("-" * len(header))
    for q in queries:
        row = f"Q{q:02d}    "
        for e in engines:
            v = results[e].get(q)
            row += f"{'n/a':>12}" if v is None else f"{1000 * v:10.1f}ms"
        print(row)
    print("-" * len(header))
    row = "total  "
    common = [q for q in queries if all(results[e].get(q) is not None for e in engines)]
    for e in engines:
        row += f"{1000 * sum(results[e][q] for q in common):10.1f}ms"
    print(row + f"   (over {len(common)} queries all engines ran)")
    row = "geomean"
    for e in engines:
        vals = [results[e][q] for q in common]
        g = statistics.geometric_mean(vals) if vals else float("nan")
        row += f"{1000 * g:10.1f}ms"
    print(row)
    if args.json:
        with open(args.json, "w") as f:
            json.dump({e: {str(q): v for q, v in r.items()} for e, r in results.items()}, f, indent=2)


if __name__ == "__main__":
    main()
