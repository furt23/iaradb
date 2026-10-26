"""Query runtime: cancellation, progress, run profiles and plan trees."""

from __future__ import annotations

import threading
import time

import numpy as np
import pyarrow as pa
import pytest

import iara as ia

N = 200_000


@pytest.fixture(scope="module")
def ctx() -> ia.SessionContext:
    rng = np.random.default_rng(7)
    facts = pa.table({"k": rng.integers(0, 10, N), "v": rng.random(N)})
    c = ia.SessionContext()
    c.register("facts", facts)
    return c


# ~4e9 join rows: runs for many seconds unless cancelled
EXPLODING = "select count(*) from facts a join facts b on a.k = b.k"


def run_in_thread(fn):
    out: dict = {}

    def target():
        try:
            out["value"] = fn()
        except BaseException as e:  # noqa: BLE001
            out["error"] = e

    t = threading.Thread(target=target)
    t.start()
    return t, out


def wait_for_running(timeout: float = 5.0) -> list[dict]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        running = ia.running_queries()
        if running and running[0]["pipelines"]:
            return running
        time.sleep(0.01)
    raise AssertionError("query never showed up as running")


def test_interrupt_cancels_running_query(ctx):
    t, out = run_in_thread(lambda: ctx.sql(EXPLODING).collect())
    running = wait_for_running()
    assert running[0]["cancelled"] is False
    t0 = time.monotonic()
    assert ia.interrupt() >= 1
    t.join(timeout=10)
    assert not t.is_alive(), "query did not stop after interrupt"
    assert time.monotonic() - t0 < 5
    assert isinstance(out.get("error"), ia.QueryCancelled)
    assert isinstance(out["error"], ia.IaraError)
    assert ia.running_queries() == []


def test_cancel_query_by_id(ctx):
    t, out = run_in_thread(lambda: ctx.sql(EXPLODING).collect())
    qid = wait_for_running()[0]["id"]
    assert ia.cancel_query(qid)
    t.join(timeout=10)
    assert isinstance(out.get("error"), ia.QueryCancelled)
    assert not ia.cancel_query(qid), "finished queries are no longer cancellable"


def test_interrupt_does_not_affect_later_queries(ctx):
    ia.interrupt()  # nothing running: a no-op
    assert ctx.sql("select count(*) from facts").collect().item() == N


def test_progress_reports_pipelines(ctx):
    t, out = run_in_thread(lambda: ctx.sql(EXPLODING).collect())
    running = wait_for_running()
    p = running[0]["pipelines"][0]
    assert {"source", "operators", "sink", "morsels_total", "morsels_done", "rows_in", "rows_out", "elapsed_ms", "finished"} <= p.keys()
    assert isinstance(running[0]["pending"], list)
    ia.interrupt()
    t.join(timeout=10)


def test_profile(ctx):
    df, prof = ctx.sql("select k, count(*) c, sum(v) s from facts where v > 0.5 group by k").profile()
    assert df.height == 10
    assert prof["cancelled"] is False and prof["elapsed_ms"] > 0
    agg = next(p for p in prof["pipelines"] if p["sink"] == "AggregateSink")
    assert agg["finished"] and agg["morsels_done"] == agg["morsels_total"]
    assert agg["rows_in"] == N
    assert 0 < agg["rows_out"] < N
    assert any("Filter" in op for op in agg["operators"])


def test_explain_tree(ctx):
    tree = ctx.sql("select a.k, count(*) from facts a join facts b on a.k = b.k where a.v > 0.9 group by a.k").explain_tree()

    def walk(n):
        yield n
        for c in n["children"]:
            yield from walk(c)

    nodes = list(walk(tree))
    names = [n["name"] for n in nodes]
    assert "HashAggregate" in names and "HashJoin" in names
    join = next(n for n in nodes if n["name"] == "HashJoin")
    assert [c["role"] for c in join["children"]] == ["probe", "build"]
    assert all(isinstance(n["detail"], str) and n["detail"] for n in nodes)
