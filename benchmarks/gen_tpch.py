"""Generate TPC-H data as Parquet using DuckDB's dbgen.

usage: python benchmarks/gen_tpch.py <scale_factor> <output_dir> [--decimal]

By default DECIMAL columns are stored as DOUBLE (the convention of most
DataFrame benchmarks); pass --decimal to keep DECIMAL(15,2).
"""

import os
import sys
import time

import duckdb

TABLES = ["lineitem", "orders", "customer", "part", "partsupp", "supplier", "nation", "region"]


def main() -> None:
    sf = float(sys.argv[1])
    out = sys.argv[2]
    keep_decimal = "--decimal" in sys.argv
    os.makedirs(out, exist_ok=True)
    db_path = os.path.join(out, "_dbgen.duckdb")
    con = duckdb.connect(db_path)
    con.execute("INSTALL tpch; LOAD tpch;")
    t0 = time.time()
    con.execute(f"CALL dbgen(sf={sf})")
    print(f"dbgen sf={sf}: {time.time() - t0:.1f}s")
    for t in TABLES:
        cols = con.execute(f"DESCRIBE {t}").fetchall()
        sel = ", ".join(
            f"CAST({c} AS DOUBLE) AS {c}" if (typ.startswith("DECIMAL") and not keep_decimal) else c
            for c, typ, *_ in cols
        )
        os.makedirs(os.path.join(out, t), exist_ok=True)
        path = os.path.join(out, t, "part-0.parquet").replace("\\", "/")
        t1 = time.time()
        con.execute(
            f"COPY (SELECT {sel} FROM {t}) TO '{path}' (FORMAT PARQUET, ROW_GROUP_SIZE 122880, COMPRESSION ZSTD)"
        )
        n = con.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
        print(f"  {t:<10} {n:>12,} rows  {time.time() - t1:.1f}s")
    con.close()
    os.remove(db_path)


if __name__ == "__main__":
    main()
