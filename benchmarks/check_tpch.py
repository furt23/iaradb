"""Run the TPC-H queries on Workhouse and DuckDB and compare results.

usage: python benchmarks/check_tpch.py <data_dir> [query numbers...]
"""

import os
import sys
import time
import traceback

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tests"))
sys.path.insert(0, os.path.dirname(__file__))

import duckdb  # noqa: E402

import workhouse as wh  # noqa: E402
from compare import diff  # noqa: E402
from tpch_queries import QUERIES, TABLES  # noqa: E402


def main() -> int:
    data = sys.argv[1]
    which = [int(x) for x in sys.argv[2:]] or sorted(QUERIES)
    ctx = wh.SessionContext()
    con = duckdb.connect()
    for t in TABLES:
        path = os.path.join(data, t).replace("\\", "/")
        ctx.register_parquet(t, path)
        con.execute(f"CREATE VIEW {t} AS SELECT * FROM read_parquet('{path}/*.parquet')")
    failures = 0
    for q in which:
        sql = QUERIES[q]
        try:
            t0 = time.perf_counter()
            res = ctx.sql(sql).collect().to_arrow()
            t1 = time.perf_counter()
            exp = con.execute(sql).arrow()
            if hasattr(exp, "read_all"):
                exp = exp.read_all()
            t2 = time.perf_counter()
            d = diff(res, exp, ordered=True)
            status = "OK  " if d is None else "DIFF"
            print(f"Q{q:02d} {status} workhouse={1000 * (t1 - t0):8.1f}ms duckdb={1000 * (t2 - t1):8.1f}ms rows={res.num_rows}")
            if d is not None:
                failures += 1
                print("     ", d)
        except Exception as e:  # noqa: BLE001
            failures += 1
            print(f"Q{q:02d} ERR  {type(e).__name__}: {e}")
            if os.environ.get("TRACE"):
                traceback.print_exc()
    print(f"{len(which) - failures}/{len(which)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
