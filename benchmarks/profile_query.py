"""Run one TPC-H query (or ad-hoc SQL) with per-pipeline timings.

usage: WORKHOUSE_PROFILE=1 python benchmarks/profile_query.py <data_dir> <query number | sql> [runs]
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import workhouse as wh  # noqa: E402
from tpch_queries import QUERIES, TABLES  # noqa: E402

data, q = sys.argv[1], sys.argv[2]
runs = int(sys.argv[3]) if len(sys.argv) > 3 else 2
ctx = wh.SessionContext()
for t in TABLES:
    ctx.register_parquet(t, os.path.join(data, t))
sql = QUERIES[int(q)] if q.isdigit() else q
for i in range(runs):
    t0 = time.perf_counter()
    df = ctx.sql(sql).collect()
    print(f"--- run {i}: {1000 * (time.perf_counter() - t0):.1f}ms, {df.height} rows", file=sys.stderr)
