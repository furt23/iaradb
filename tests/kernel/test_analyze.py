"""Analyze: a profiled run of a query with its plan (the Studio's Analyze screen)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from workhouse.kernel.analyze import analyze_query
from workhouse.kernel.history import History
from workhouse.kernel.runtime.interrupt import Interruptor
from workhouse.kernel.session import KernelSession

GROUPED = "select grp, count(*) as n from sales where amount > 400 group by grp order by grp"


@pytest.fixture()
def session(workspace: Path):
    cwd = os.getcwd()
    s = KernelSession(workspace)
    yield s
    os.chdir(cwd)


def analyze(session: KernelSession, query: str) -> dict[str, Any]:
    return session.handlers()["sql.analyze"]({"query": query}, lambda event, data: None)


def walk(node: dict[str, Any]):
    yield node
    for child in node["children"]:
        yield from walk(child)


def test_analyze_returns_plan_profile_and_text(session: KernelSession):
    out = analyze(session, GROUPED)
    assert {"query", "at", "rows", "plan", "text", "profile"} <= set(out) <= {"query", "at", "rows", "plan", "text", "profile", "requests"}
    assert out["query"] == GROUPED and isinstance(out["at"], int) and out["at"] > 0
    assert out["rows"] == 7 and "result" not in out
    assert out["text"].strip()
    assert out["profile"]["pipelines"] and out["profile"]["elapsed_ms"] >= 0
    nodes = list(walk(out["plan"]))
    assert all(set(n) == {"name", "detail", "role", "metrics", "children"} for n in nodes)
    assert all(n["name"] and n["metrics"]["rows_out"] >= 0 for n in nodes)  # the engine measures every operator
    assert all(n["role"] in ("probe", "build", None) for n in nodes)


def test_analyze_counts_rows_of_a_scan(session: KernelSession):
    # amount = i * 0.5 for i in 0..999: more than 400 is i in 801..999
    assert analyze(session, "select * from sales where amount > 400")["rows"] == 199


def test_analyze_records_history(session: KernelSession):
    analyze(session, GROUPED)
    entry = session.history.recent(1)[0]
    assert entry["source"] == "analyze" and entry["rows"] == 7 and entry["error"] is None


def test_analyze_errors_propagate_and_are_recorded(session: KernelSession):
    with pytest.raises(Exception, match="nope"):
        analyze(session, "select nope from sales")
    entry = session.history.recent(1)[0]
    assert entry["source"] == "analyze" and "nope" in entry["error"]


class _Batch:
    def __init__(self, n: int) -> None:
        self.num_rows = n


class _Stream:
    def batches(self):
        yield from (_Batch(2), _Batch(3))

    def profile(self):
        return {"id": 1, "elapsed_ms": 2.5, "cancelled": False, "pipelines": []}


class _ProfiledLazy:
    """A lazy query without the engine's ``analyze()``: a profiled stream and explain_tree()."""

    def stream(self):
        return _Stream()

    def explain_tree(self):
        return {"name": "Filter", "detail": "Filter(x > 1)", "role": None, "children": [{"name": "ParquetScan", "detail": "ParquetScan(t)", "role": None, "children": []}]}

    def explain(self, optimized: bool = True) -> str:
        return "Filter\n  ParquetScan"


class _EngineLazy(_ProfiledLazy):
    """The engine's ``analyze()``: per-operator metrics and storage requests."""

    def stream(self):  # pragma: no cover - must not run when analyze() exists
        raise AssertionError("stream() is not used when analyze() is available")

    def analyze(self) -> dict[str, Any]:
        plan = {
            "name": "ParquetScan",
            "detail": "ParquetScan(t)",
            "role": None,
            "metrics": {"rows_out": 3, "elapsed_ms": 1.5, "batches": 1},
            "children": [],
        }
        profile = {"id": 2, "elapsed_ms": 2.0, "cancelled": False, "pipelines": [], "memory_peak": 4096}
        return {"plan": plan, "profile": profile, "rows": 3, "requests": {"list": 0, "head": 1, "get": 2, "bytes": 4096}}


class _FakeWorkspace:
    def __init__(self, lazy: Any) -> None:
        self.lazy = lazy

    def sql(self, query: str) -> Any:
        return self.lazy


def test_analyze_falls_back_to_profile_and_explain_tree(tmp_path: Path):
    out = analyze_query(_FakeWorkspace(_ProfiledLazy()), "q", History(tmp_path), Interruptor())
    assert out["rows"] == 5 and "requests" not in out
    assert out["plan"]["name"] == "Filter" and out["plan"]["metrics"] is None
    assert out["plan"]["children"][0]["name"] == "ParquetScan"
    assert out["text"] == "Filter\n  ParquetScan"


def test_analyze_uses_the_engine_analyze_when_offered(tmp_path: Path):
    out = analyze_query(_FakeWorkspace(_EngineLazy()), "q", History(tmp_path), Interruptor())
    assert out["rows"] == 3
    assert out["plan"]["metrics"] == {"rows_out": 3, "elapsed_ms": 1.5, "batches": 1}
    assert out["requests"] == {"list": 0, "head": 1, "get": 2, "bytes": 4096}
    assert out["profile"]["memory_peak"] == 4096
