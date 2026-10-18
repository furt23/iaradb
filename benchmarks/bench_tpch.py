"""TPC-H benchmark: all engines read the same Parquet files (one directory per table).

usage: python benchmarks/bench_tpch.py <data_dir> [--runs N] [--engines iara,duckdb,polars,...] [--queries 1,2,3]
                                       [--timeout S] [--validate] [--json out.json]

Engines: iara, duckdb, polars (DataFrame versions in tpch_polars.py), polars-streaming,
polars-sql, datafusion, chdb, spark, daft. Each engine runs in its own process.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import harness  # noqa: E402
from tpch_queries import QUERIES, TABLES  # noqa: E402


def tables(data: str) -> dict[str, str]:
    return {t: os.path.join(data, t) for t in TABLES}


def setup_polars(tables, queries, engine="auto"):
    from tpch_polars import QUERIES as PQ

    import polars as pl

    t = {n: pl.scan_parquet(harness._glob(p)) for n, p in tables.items()}
    return lambda q: PQ[q](t).collect(engine=engine).to_arrow()


def setup_polars_streaming(tables, queries):
    return setup_polars(tables, queries, "streaming")


SETUPS = {**harness.SETUPS, "polars": setup_polars, "polars-streaming": setup_polars_streaming}

if __name__ == "__main__":
    harness.main("tpch", tables, QUERIES, SETUPS, "iara,duckdb,polars,datafusion,chdb,spark,daft")
