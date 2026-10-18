"""ClickBench benchmark on hits.parquet.

usage: python benchmarks/bench_clickbench.py <hits.parquet> [--runs N] [--engines iara,duckdb,...] [--queries 0,1,2]
                                             [--timeout S] [--json out.json]

Use the typed copy made by `prepare_hits.py` (EventTime as TIMESTAMP, EventDate as
DATE, strings as UTF-8): the original hits.parquet stores them as integers and
binary, which every engine reads differently.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import harness  # noqa: E402
from clickbench_queries import QUERIES  # noqa: E402

SETUPS = {**harness.SETUPS, "polars": harness.setup_polars_sql}
del SETUPS["polars-sql"]

if __name__ == "__main__":
    harness.main("clickbench", lambda path: {"hits": path}, QUERIES, SETUPS, "iara,duckdb,polars,datafusion,chdb,spark,daft")
