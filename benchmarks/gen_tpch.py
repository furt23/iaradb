"""Generate TPC-H data as Parquet using tpchgen-cli (fast) or DuckDB dbgen.

usage: python benchmarks/gen_tpch.py <scale_factor> <output_dir> [--compression ZSTD(1)] [--temp-dir DIR] [--duckdb] [--decimal]
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time

TABLES = ["lineitem", "orders", "customer", "part", "partsupp", "supplier", "nation", "region"]


def generate_with_tpchgen(sf: float, out: str, compression: str, temp_dir: str | None = None) -> bool:
    tpchgen = shutil.which("tpchgen-cli") or shutil.which("tpchgen")
    if not tpchgen:
        return False

    work_dir = temp_dir if temp_dir else tempfile.mkdtemp(prefix="tpchgen_")
    os.makedirs(work_dir, exist_ok=True)
    cleanup_work_dir = temp_dir is None

    t0 = time.time()
    cmd = [tpchgen, "parquet", "-s", str(sf), "-o", work_dir, "-c", compression]
    print(f"Running: {' '.join(cmd)}")
    ret = subprocess.run(cmd)
    if ret.returncode != 0:
        print(f"tpchgen-cli failed with exit code {ret.returncode}", file=sys.stderr)
        return False

    print(f"tpchgen-cli sf={sf}: {time.time() - t0:.1f}s")

    for t in TABLES:
        src = os.path.join(work_dir, f"{t}.parquet")
        target_dir = os.path.join(out, t)
        os.makedirs(target_dir, exist_ok=True)
        dst = os.path.join(target_dir, f"{t}.parquet")
        t1 = time.time()
        if os.path.exists(src):
            if os.path.abspath(src) != os.path.abspath(dst):
                shutil.move(src, dst)
            size_mb = os.path.getsize(dst) / (1024 * 1024)
            print(f"  {t:<10} {size_mb:>8.1f} MB  {time.time() - t1:.1f}s")

    if cleanup_work_dir and os.path.exists(work_dir):
        shutil.rmtree(work_dir, ignore_errors=True)

    return True


def generate_with_duckdb(sf: float, out: str, keep_decimal: bool) -> None:
    import duckdb

    os.makedirs(out, exist_ok=True)
    db_path = os.path.join(out, "_dbgen.duckdb")
    con = duckdb.connect(db_path)
    con.execute("INSTALL tpch; LOAD tpch;")
    t0 = time.time()
    con.execute(f"CALL dbgen(sf={sf})")
    print(f"duckdb dbgen sf={sf}: {time.time() - t0:.1f}s")
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
    if os.path.exists(db_path):
        os.remove(db_path)


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate TPC-H Parquet datasets.")
    ap.add_argument("scale_factor", type=float, help="Scale factor (e.g. 1, 10, 100)")
    ap.add_argument("output_dir", help="Output directory")
    ap.add_argument("--compression", default="ZSTD(1)", help="Parquet compression format (default: ZSTD(1))")
    ap.add_argument("--temp-dir", default=None, help="Temporary directory for intermediate files")
    ap.add_argument("--duckdb", action="store_true", help="Force using DuckDB dbgen instead of tpchgen-cli")
    ap.add_argument("--decimal", action="store_true", help="Keep DECIMAL(15,2) when using DuckDB")
    args = ap.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    if not args.duckdb:
        success = generate_with_tpchgen(args.scale_factor, args.output_dir, args.compression, args.temp_dir)
        if success:
            return
        print("tpchgen-cli not found or failed, falling back to DuckDB dbgen...", file=sys.stderr)

    generate_with_duckdb(args.scale_factor, args.output_dir, args.decimal)


if __name__ == "__main__":
    main()
