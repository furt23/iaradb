"""Streaming results and the memory limit, from Python."""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import iara as ia

sys.path.insert(0, os.path.dirname(__file__))
from compare import diff  # noqa: E402

N = 600_000


@pytest.fixture(scope="module")
def ctx() -> ia.SessionContext:
    rng = np.random.default_rng(7)
    ids = np.arange(N)
    t = pa.table(
        {
            "id": ids,
            "g": (ids * 37) % 50_000,
            "s": pa.array([f"name-{i % 90_001:06d}" for i in range(N)]),
            "x": rng.random(N),
        }
    )
    c = ia.SessionContext()
    c.register("t", t)
    return c


@pytest.fixture()
def limit():
    """Set a memory limit for one test (the pool is process-wide)."""

    def set_(value):
        ia.set_memory_limit(value)

    yield set_
    ia.set_memory_limit(None)


def test_reader_matches_collect(ctx: ia.SessionContext) -> None:
    lf = ctx.sql("select id, s, x from t where g < 20000 order by s, id")
    expected = lf.collect().to_arrow()
    reader = lf.to_reader()
    assert reader.schema == expected.schema
    batches = list(reader)
    assert len(batches) > 1
    assert pa.Table.from_batches(batches, expected.schema).equals(expected)
    # anything reading Arrow streams reads a LazyFrame lazily
    assert pa.table(lf).equals(expected)


def test_sinks_write_without_collecting(ctx: ia.SessionContext, tmp_path: Path) -> None:
    lf = ctx.sql("select id, g, s from t where id % 4 = 0 order by g, id")
    expected = lf.collect().to_arrow()
    assert lf.sink_parquet(tmp_path / "out" / "r.parquet", row_group_size=20_000) == expected.num_rows
    back = pq.read_table(tmp_path / "out" / "r.parquet")
    assert back.column("id").equals(expected.column("id"))
    assert pq.ParquetFile(tmp_path / "out" / "r.parquet").metadata.num_row_groups > 1
    assert lf.sink_csv(tmp_path / "r.csv") == expected.num_rows
    assert len((tmp_path / "r.csv").read_text().splitlines()) == expected.num_rows + 1


def test_dropping_a_reader_stops_the_query(ctx: ia.SessionContext) -> None:
    before = threading.active_count()
    reader = ctx.sql("select a.id, b.s from t a join t b on a.g = b.g").to_reader()  # ~7M rows
    first = reader.read_next_batch()
    assert first.num_rows > 0
    del reader
    import gc
    import time

    gc.collect()
    deadline = time.monotonic() + 10
    while threading.active_count() > before and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not ia.running_queries()


def test_errors_reach_the_reader(ctx: ia.SessionContext) -> None:
    with pytest.raises(ia.IaraError, match="not found"):
        ctx.sql("select nope from t").to_reader()


def test_streams_end_with_their_profile(ctx: ia.SessionContext) -> None:
    stream = ctx.sql("select g, count(*) as n from t group by g").stream()
    assert stream.profile() is None
    rows = sum(b.num_rows for b in stream.batches())
    profile = stream.profile()
    assert rows == 50_000 and profile["pipelines"] and profile["spilled_bytes"] == 0


def test_an_interrupted_stream_raises_query_cancelled(ctx: ia.SessionContext) -> None:
    stream = ctx.sql("select a.id, b.s from t a join t b on a.g = b.g").stream()  # ~7M rows
    batches = stream.batches()
    assert next(batches).num_rows > 0
    ia.interrupt()
    with pytest.raises(ia.QueryCancelled):
        for _ in batches:
            pass


def test_memory_limit_spills_and_matches(ctx: ia.SessionContext, limit) -> None:
    queries = [
        "select g, count(*) as n, sum(x) as sx, min(s) as lo from t group by g order by g",
        "select count(*) as n, sum(a.x * b.x) as p from t a join t b on a.id = b.id",
        "select id, s from t order by s desc, id",
        "select id, row_number() over (partition by g order by id) as rn, sum(x) over (partition by g) as sx from t order by id",
    ]
    expected = [ctx.sql(q).collect().to_arrow() for q in queries]
    limit("4MB")
    usage = ia.memory_usage()
    assert usage["limit"] == 4 << 20
    for q, want in zip(queries, expected):
        # spilling aggregates rows in another order: float sums may differ in the last bits
        assert diff(ctx.sql(q).collect().to_arrow(), want, rtol=1e-12) is None, q
    assert ia.memory_usage()["spilled"] > usage["spilled"]
    _, profile = ctx.sql(queries[2]).profile()
    assert profile["spilled_bytes"] > 0 and 0 < profile["memory_peak"]


@pytest.mark.skipif(sys.platform == "win32", reason="the allocator's figures come from jemalloc (Linux, macOS)")
def test_memory_usage_reports_the_allocator() -> None:
    ia.sql("select sum(x) as s from t", t=pa.table({"x": np.arange(N)})).collect()
    u = ia.memory_usage()
    assert 0 < u["heap"] <= u["resident"]


def test_memory_limits_parse() -> None:
    try:
        ia.set_memory_limit(123456)
        assert ia.memory_usage()["limit"] == 123456
        ia.set_memory_limit("1.5GB")
        assert ia.memory_usage()["limit"] == 3 << 29
        with pytest.raises(ValueError):
            ia.set_memory_limit("lots")
    finally:
        ia.set_memory_limit(None)
    assert ia.memory_usage()["limit"] is None
