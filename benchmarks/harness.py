"""Shared benchmark driver: SQL engine adapters and a runner that isolates each engine in its own process.

The parent runs one child process per engine. The child sets the engine up, runs
the queries in order and prints one JSON line per query. A query that runs past
``--timeout`` (or crashes the process, e.g. out of memory) is recorded as failed
and a fresh child picks up the remaining queries.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import queue
import re
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from importlib import metadata

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tests"))

CPUS = os.cpu_count() or 4
# children prefix their result lines, since engines may print to stdout themselves
MARK = "@@bench "

# Setup(tables, queries) -> run(query_id) -> pyarrow.Table.
# tables maps a table name to a Parquet file or a directory of Parquet files.
Setup = Callable[[dict[str, str], dict], Callable[[int], object]]

PACKAGES = {
    "iara": "iaradb",
    "duckdb": "duckdb",
    "polars": "polars",
    "polars-sql": "polars",
    "datafusion": "datafusion",
    "chdb": "chdb",
    "spark": "pyspark",
    "daft": "daft",
}


def _glob(p: str) -> str:
    p = p.replace("\\", "/")
    return f"{p}/*.parquet" if os.path.isdir(p) else p


def _total_ram() -> int:
    import psutil

    return psutil.virtual_memory().total


def setup_iara(tables, queries):
    import iara as ia

    ctx = ia.SessionContext()
    for t, p in tables.items():
        ctx.register_parquet(t, p)
    return lambda q: ctx.sql(queries[q]).collect().to_arrow()


def setup_duckdb(tables, queries):
    import duckdb

    con = duckdb.connect()
    # without it DuckDB parses the Parquet footers on every query (~130 ms on hits.parquet)
    con.execute("SET parquet_metadata_cache = true")
    for t, p in tables.items():
        con.execute(f"CREATE VIEW {t} AS SELECT * FROM read_parquet('{_glob(p)}')")
    return lambda q: con.execute(queries[q]).fetch_arrow_table()


def setup_polars_sql(tables, queries):
    import polars as pl

    ctx = pl.SQLContext()
    for t, p in tables.items():
        ctx.register(t, pl.scan_parquet(_glob(p)))
    queries = {q: _length(sql) for q, sql in queries.items()}
    return lambda q: ctx.execute(queries[q]).collect().to_arrow()


def setup_datafusion(tables, queries):
    from datafusion import SessionConfig, SessionContext

    # keep identifier case (ClickBench columns are CamelCase), as DataFusion's own ClickBench setup does
    cfg = SessionConfig().with_target_partitions(CPUS).set("datafusion.sql_parser.enable_ident_normalization", "false")
    ctx = SessionContext(cfg)
    for t, p in tables.items():
        ctx.register_parquet(t, p.replace("\\", "/"))
    queries = {q: _length(s) for q, s in queries.items()}
    return lambda q: ctx.sql(queries[q]).to_arrow_table()


# ClickHouse defaults differ from standard SQL: outer joins fill missing values
# with defaults unless join_use_nulls is set (TPC-H Q13 counts those NULLs).
CHDB_SETTINGS = "join_use_nulls = 1, allow_experimental_correlated_subqueries = 1"


def setup_chdb(tables, queries):
    from chdb import session

    s = session.Session()
    for t, p in tables.items():
        s.query(f"CREATE VIEW {t} AS SELECT * FROM file('{_glob(p)}', Parquet)")
    queries = {q: f"{_length(sql).strip().rstrip(';')}\nSETTINGS {CHDB_SETTINGS}" for q, sql in queries.items()}
    return lambda q: s.query(queries[q], "ArrowTable")


def setup_spark(tables, queries):
    import logging

    from pyspark.sql import SparkSession

    logging.getLogger("py4j").setLevel(logging.ERROR)
    mem = int(_total_ram() * 0.75) >> 30
    tmp = os.environ.get("SPARK_LOCAL_DIRS", tempfile.gettempdir())
    spark = (
        SparkSession.builder.master(f"local[{CPUS}]")
        .config("spark.driver.memory", f"{mem}g")
        .config("spark.driver.maxResultSize", "8g")
        .config("spark.sql.shuffle.partitions", str(CPUS * 2))
        .config("spark.sql.parquet.binaryAsString", "true")
        .config("spark.local.dir", tmp)
        .config("spark.ui.enabled", "false")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("ERROR")
    for t, p in tables.items():
        spark.read.parquet(p.replace("\\", "/")).createOrReplaceTempView(t)
    # Spark's regexp_replace refers to groups as $1
    queries = {q: _length(sql).replace("'\\1'", "'$1'") for q, sql in queries.items()}
    return lambda q: spark.sql(queries[q]).toArrow()


def setup_daft(tables, queries):
    import daft

    frames = {t: daft.read_parquet(_glob(p)) for t, p in tables.items()}
    # Daft parses SUBSTRING only in its function form
    queries = {q: re.sub(r"substring\((\w+) from (\d+) for (\d+)\)", r"substring(\1, \2, \3)", _length(sql)) for q, sql in queries.items()}
    return lambda q: daft.sql(queries[q], **frames).to_arrow()


def _length(sql: str) -> str:
    """STRLEN is a DuckDB/ClickHouse alias; the other engines spell it LENGTH."""
    return sql.replace("STRLEN(", "LENGTH(")


SETUPS: dict[str, Setup] = {
    "iara": setup_iara,
    "duckdb": setup_duckdb,
    "polars-sql": setup_polars_sql,
    "datafusion": setup_datafusion,
    "chdb": setup_chdb,
    "spark": setup_spark,
    "daft": setup_daft,
}


# ---------------------------------------------------------------- child


def _child(setups: dict[str, Setup], tables: dict[str, str], queries: dict, a) -> None:
    import pyarrow as pa

    from compare import diff

    def emit(**kw) -> None:
        print(MARK + json.dumps(kw), flush=True)

    t0 = time.perf_counter()
    run = setups[a.engine](tables, queries)
    emit(setup=time.perf_counter() - t0)
    for q in [int(x) for x in a.queries.split(",")]:
        try:
            t0 = time.perf_counter()
            out = run(q)  # warm-up
            warm = time.perf_counter() - t0
            wrong = None
            if a.ref:
                path = os.path.join(a.ref, f"q{q}.arrow")
                if a.engine == "duckdb" and not os.path.exists(path):
                    with pa.ipc.new_file(path, out.schema) as w:
                        w.write_table(out)
                elif os.path.exists(path):
                    ref = pa.ipc.open_file(path).read_all()
                    # decimal AVG keeps 6 fraction digits in some engines
                    wrong = diff(out, ref, ordered=a.ordered, rtol=1e-4)
            del out
            # a slow query is timed once; its warm-up already paid the cold cache
            runs = a.runs if warm < a.slow else 1
            times = []
            for _ in range(runs):
                t0 = time.perf_counter()
                run(q)
                times.append(time.perf_counter() - t0)
            emit(q=q, t=statistics.median(times), wrong=wrong)
        except Exception as ex:  # noqa: BLE001
            emit(q=q, t=None, err=f"{type(ex).__name__}: {(str(ex).strip().splitlines() or [''])[0][:200]}")


# ---------------------------------------------------------------- parent


def _run_engine(script: str, engine: str, data: str, queries: list[int], a) -> tuple[dict, dict]:
    """Run one engine in child processes; returns ({q: seconds|None}, {q: error})."""
    times: dict[int, float | None] = {}
    errors: dict[int, str] = {}
    remaining = list(queries)
    while remaining:
        args = [sys.executable, script, data, "--child", engine, "--queries", ",".join(map(str, remaining))]
        args += ["--runs", str(a.runs), "--slow", str(a.slow)]
        if a.ref:
            args += ["--ref", a.ref]
        if a.ordered:
            args.append("--ordered")
        err = tempfile.TemporaryFile("w+")
        p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=err, text=True)
        lines: queue.Queue = queue.Queue()

        def pump(p=p, lines=lines) -> None:
            for line in p.stdout:
                lines.put(line)
            lines.put(None)

        threading.Thread(target=pump, daemon=True).start()
        limit = a.timeout + 600  # setup gets extra room (JVM start, metadata)
        while remaining:
            q = remaining[0]
            try:
                line = lines.get(timeout=limit)
            except queue.Empty:
                p.kill()
                times[q], errors[q] = None, f"timeout ({a.timeout}s)"
                print(f"{engine:<12} Q{q:02d}   timeout", file=sys.stderr, flush=True)
                remaining.pop(0)
                break
            if line is None:  # the child died mid-query
                p.wait()
                err.seek(0)
                tail = [s for s in err.read().strip().splitlines() if s.strip()]
                msg = f"crashed (exit {p.returncode}): {tail[-1][:200] if tail else ''}"
                times[q], errors[q] = None, msg
                print(f"{engine:<12} Q{q:02d}   {msg}", file=sys.stderr, flush=True)
                remaining.pop(0)
                break
            if not line.startswith(MARK):
                continue
            r = json.loads(line[len(MARK) :])
            limit = a.timeout
            if "setup" in r:
                continue
            assert r["q"] == q
            remaining.pop(0)
            times[q] = r["t"]
            if r.get("err"):
                errors[q] = r["err"]
            elif r.get("wrong"):
                errors[q] = f"wrong result: {r['wrong']}"[:300]
            v = r["t"]
            note = errors.get(q, "")
            print(f"{engine:<12} Q{q:02d} {'     n/a' if v is None else f'{1000 * v:8.1f}ms'}  {note}", file=sys.stderr, flush=True)
        if p.poll() is None and not remaining:
            p.wait()
        elif p.poll() is None:
            p.kill()
        err.close()
    return times, errors


def _summary(engines: list[str], queries: list[int], results: dict) -> None:
    header = "query  " + "".join(f"{e:>13}" for e in engines)
    print(header)
    print("-" * len(header))
    for q in queries:
        row = f"Q{q:02d}    "
        for e in engines:
            v = results[e].get(q)
            row += f"{'n/a':>13}" if v is None else f"{1000 * v:11.1f}ms"
        print(row)
    print("-" * len(header))
    for name, agg in (("total  ", sum), ("geomean", statistics.geometric_mean)):
        row = name
        for e in engines:
            vals = [v for v in results[e].values() if v is not None]
            row += f"{1000 * agg(vals):11.1f}ms" if vals else f"{'n/a':>13}"
        print(row + ("   (each engine over the queries it completed)" if name == "total  " else ""))
    for e in engines:
        ok = sum(1 for v in results[e].values() if v is not None)
        print(f"{e}: {ok}/{len(queries)} queries")


def main(name: str, tables: Callable[[str], dict[str, str]], queries: dict, setups: dict[str, Setup], default_engines: str) -> None:
    ap = argparse.ArgumentParser(description=f"{name} benchmark")
    ap.add_argument("data")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--engines", default=default_engines)
    ap.add_argument("--queries", default="")
    ap.add_argument("--timeout", type=int, default=600, help="seconds per query (warm-up plus timed runs)")
    ap.add_argument("--slow", type=float, default=30.0, help="a query whose warm-up takes longer is timed once")
    ap.add_argument("--json", default="")
    ap.add_argument("--validate", action="store_true", help="check every engine's results against DuckDB")
    ap.add_argument("--child")
    ap.add_argument("--ref", default="")
    ap.add_argument("--ordered", action="store_true")
    a = ap.parse_args()
    if a.child:
        a.engine = a.child
        _child(setups, tables(a.data), queries, a)
        return

    engines = [e.strip() for e in a.engines.split(",") if e.strip()]
    for e in engines:
        if e not in setups:
            sys.exit(f"unknown engine {e!r}; known: {', '.join(setups)}")
    qs = [int(q) for q in a.queries.split(",")] if a.queries else sorted(queries)
    if a.validate:
        a.ref = tempfile.mkdtemp(prefix="bench-ref-")
        a.ordered = True
        if "duckdb" in engines:
            engines.remove("duckdb")
        engines.insert(0, "duckdb")

    script = os.path.abspath(sys.argv[0])
    results: dict[str, dict] = {}
    errors: dict[str, dict] = {}
    for e in engines:
        results[e], errors[e] = _run_engine(script, e, a.data, qs, a)
        if a.json:
            _save(a, name, results, errors)
    _summary(engines, qs, results)


def _save(a, name: str, results: dict, errors: dict) -> None:
    """Write the results so far, keeping the engines an earlier run of the same file measured."""
    out = {"meta": {}, "times": {}, "errors": {}}
    if os.path.exists(a.json):
        with open(a.json) as f:
            out = json.load(f)
    versions = out["meta"].get("versions", {})
    for e in results:
        try:
            versions[e] = metadata.version(PACKAGES.get(e, e))
        except metadata.PackageNotFoundError:
            versions[e] = None
        out["times"][e] = {str(q): v for q, v in results[e].items()}
        out["errors"][e] = {str(q): m for q, m in errors[e].items()}
    out["meta"] = {
        "benchmark": name,
        "data": a.data,
        "runs": a.runs,
        "timeout": a.timeout,
        "date": time.strftime("%Y-%m-%d"),
        "machine": platform.machine(),
        "cpus": CPUS,
        "ram_gb": round(_total_ram() / 2**30, 1),
        "python": platform.python_version(),
        "versions": versions,
    }
    with open(a.json, "w") as f:
        json.dump(out, f, indent=1)
