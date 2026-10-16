"""EXPLAIN ANALYZE: `LazyFrame.analyze()` and the SQL statement, with per-operator metrics."""

from __future__ import annotations

import threading
import time

import duckdb
import numpy as np
import pyarrow as pa
import pytest

import iara as ia

N = 200_000
GROUPS = 40

QUERY = (
    "select d.name, count(*) as n, sum(f.v) as total "
    "from facts f join dims d on f.k = d.k where f.v > 0.9 group by d.name"
)


@pytest.fixture(scope="module")
def tables() -> dict[str, pa.Table]:
    rng = np.random.default_rng(11)
    return {
        "facts": pa.table({"k": rng.integers(0, GROUPS, N), "v": rng.random(N)}),
        "dims": pa.table({"k": np.arange(GROUPS), "name": [f"dim-{i:02d}" for i in range(GROUPS)]}),
    }


@pytest.fixture(scope="module")
def ctx(tables) -> ia.SessionContext:
    c = ia.SessionContext()
    for name, t in tables.items():
        c.register(name, t)
    return c


@pytest.fixture(scope="module")
def duck(tables) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    for name, t in tables.items():
        con.register(name, t)
    return con


def walk(node: dict):
    yield node
    for c in node["children"]:
        yield from walk(c)


def named(plan: dict, name: str) -> list[dict]:
    return [n for n in walk(plan) if n["name"] == name]


def test_analyze_returns_plan_profile_rows_and_requests(ctx, duck):
    run = ctx.sql(QUERY).analyze()
    assert set(run) == {"plan", "profile", "rows", "requests"}
    assert run["rows"] == duck.execute(f"select count(*) from ({QUERY})").fetchone()[0] == GROUPS
    assert set(run["requests"]) == {"list", "head", "get", "bytes"}
    # the profile is the one a streamed run (and profile()) gives
    stream = ctx.sql(QUERY).stream()
    assert sum(b.num_rows for b in stream.batches()) == GROUPS
    prof = stream.profile()
    assert run["profile"].keys() == prof.keys() == ctx.sql(QUERY).profile()[1].keys()
    assert [p["sink"] for p in run["profile"]["pipelines"]] == [p["sink"] for p in prof["pipelines"]]
    assert [p["rows_out"] for p in run["profile"]["pipelines"]] == [p["rows_out"] for p in prof["pipelines"]]
    assert run["profile"]["elapsed_ms"] > 0 and run["profile"]["cancelled"] is False


def test_every_node_has_metrics_and_the_real_row_counts(ctx, duck):
    plan = ctx.sql(QUERY).analyze()["plan"]
    for n in walk(plan):
        m = n["metrics"]
        assert m is not None, n["detail"]
        assert m["rows_out"] >= 0 and m["elapsed_ms"] >= 0 and m["batches"] >= 1
        assert set(m) <= {"rows_out", "elapsed_ms", "batches", "memory_peak", "spilled_bytes"}

    kept = duck.execute("select count(*) from facts where v > 0.9").fetchone()[0]
    # the facts are pre-aggregated by their key below the join: one row per key reaches it
    final, partial = named(plan, "HashAggregate")
    assert final["metrics"]["rows_out"] == partial["metrics"]["rows_out"] == GROUPS
    assert named(plan, "Filter")[0]["metrics"]["rows_out"] == kept
    assert named(plan, "HashJoin")[0]["metrics"]["rows_out"] == GROUPS
    scans = sorted(n["metrics"]["rows_out"] for n in walk(plan) if not n["children"])
    assert scans == [GROUPS, N]
    # the aggregation and the join build hold memory
    assert named(plan, "HashAggregate")[0]["metrics"]["memory_peak"] > 0


def test_the_plan_is_explain_trees_with_metrics(ctx):
    lf = ctx.sql(QUERY)

    def strip(n: dict) -> dict:
        own = {k: v for k, v in n.items() if k not in ("metrics", "children")}
        return own | {"children": [strip(c) for c in n["children"]]}

    plan = lf.analyze()["plan"]
    assert strip(plan) == strip(lf.explain_tree())
    join = named(plan, "HashJoin")[0]
    assert [c["role"] for c in join["children"]] == ["probe", "build"]


def test_row_counts_of_other_shapes_match_duckdb(ctx, duck):
    for q in (
        "select k, v from facts where v < 0.01 order by v limit 7",
        "select k, count(*) from facts group by k order by k",
        "select f.k from facts f where f.k in (select k from dims where k < 5)",
        "select k from facts where v < 0.001 union all select k from dims",
    ):
        run = ctx.sql(q).analyze()
        assert run["rows"] == len(duck.execute(q).fetchall()), q
        assert run["plan"]["metrics"]["rows_out"] == run["rows"], q


def test_the_result_is_not_returned(ctx):
    run = ctx.sql("select * from facts").analyze()
    assert run["rows"] == N
    assert "data" not in run and "table" not in run


def test_analyze_can_be_interrupted(ctx):
    # ~4e9 join rows: runs for many seconds unless cancelled
    lf = ctx.sql("select count(*) from facts a join facts b on a.k = b.k")
    out: dict = {}

    def target():
        try:
            out["value"] = lf.analyze()
        except BaseException as e:  # noqa: BLE001
            out["error"] = e

    t = threading.Thread(target=target)
    t.start()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not (ia.running_queries() and ia.running_queries()[0]["pipelines"]):
        time.sleep(0.01)
    assert ia.interrupt() >= 1
    t.join(timeout=10)
    assert not t.is_alive(), "analyze did not stop after interrupt"
    assert isinstance(out.get("error"), ia.QueryCancelled)
    assert ia.running_queries() == []


def test_plain_queries_are_unaffected(ctx, duck):
    # analyzing leaves nothing behind: the same query still collects the same result
    lf = ctx.sql(QUERY)
    lf.analyze()
    got = sorted((r["name"], r["n"], round(r["total"], 6)) for r in lf.collect().to_arrow().to_pylist())
    want = sorted((n, c, round(t, 6)) for n, c, t in duck.execute(QUERY).fetchall())
    assert got == want


def test_sql_explain_analyze(ctx):
    out = ctx.sql(f"explain analyze {QUERY}").collect().to_arrow()
    assert out.column_names == ["plan"] and out.num_rows == 1
    text = out.column("plan")[0].as_py()
    assert "HashAggregate" in text and "HashJoin" in text
    op_lines = [ln for ln in text.splitlines() if not ln.strip().startswith("[")]
    assert op_lines and all("rows=" in ln and "time=" in ln and "ms" in ln for ln in op_lines), text
    assert f"rows={GROUPS} " in text


def test_sql_explain_does_not_run_the_query(ctx):
    text = ctx.sql(f"explain {QUERY}").collect().to_arrow().column("plan")[0].as_py()
    assert "Physical plan" in text and "rows=" not in text


def test_only_queries_can_be_explained(ctx):
    with pytest.raises(ia.IaraError):
        ctx.sql("explain analyze create table x as select 1")
