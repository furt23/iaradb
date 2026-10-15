"""Query parameters of the SQL editor: the request's ``params`` reach ``Workspace.sql``."""

from __future__ import annotations

import datetime as dt
import inspect
import os
from pathlib import Path
from typing import Any

import pytest

from iara.kernel.params import bind_params
from iara.kernel.session import KernelSession
from iara.workspaces import Workspace

def _engine_binds_params() -> bool:
    """Whether the built engine binds ``:name`` placeholders (the Python side may be ahead of the native build)."""
    if "params" not in inspect.signature(Workspace.sql).parameters:
        return False
    try:
        import iara as ia

        ia.SessionContext().sql("select :a as a", {"a": 1}).collect()
        return True
    except Exception:  # noqa: BLE001
        return False


needs_engine = pytest.mark.skipif(not _engine_binds_params(), reason="the engine build does not bind SQL parameters yet")


@pytest.fixture()
def session(workspace: Path):
    cwd = os.getcwd()
    s = KernelSession(workspace)
    yield s
    os.chdir(cwd)


def call(session: KernelSession, method: str, **p: Any) -> Any:
    return session.handlers()[method](p, lambda event, data: None)


class Spy:
    """Stands in for ``Workspace.sql``: records the ``params`` it gets, then runs the query without them."""

    def __init__(self, ws: Workspace) -> None:
        self.calls: list[dict[str, Any] | None] = []
        self._sql = ws.sql

    def __call__(self, query: str, params: dict[str, Any] | None = None, **tables: Any) -> Any:
        self.calls.append(params)
        return self._sql(query, **tables)


@pytest.fixture()
def spy(session: KernelSession) -> Spy:
    s = Spy(session.ws)
    session.ws.sql = s  # type: ignore[method-assign]
    return s


def test_bind_params():
    assert bind_params({"query": "select 1"}) is None
    assert bind_params({"query": "select 1", "params": {}}) is None
    assert bind_params({"params": {"n": 3, "s": "EU", "f": True}}) == {"n": 3, "s": "EU", "f": True}


def test_bind_params_converts_only_declared_dates():
    got = bind_params({"params": {"d": "2026-01-31", "t": "2026-01-31"}, "param_types": {"d": "date", "t": "text"}})
    assert got == {"d": dt.date(2026, 1, 31), "t": "2026-01-31"}


def test_bind_params_rejects_a_bad_date():
    with pytest.raises(ValueError, match="not a date"):
        bind_params({"params": {"d": "31/01/2026"}, "param_types": {"d": "date"}})


@needs_engine
def test_run_passes_params_and_records_them(session: KernelSession, spy: Spy):
    call(session, "sql.run", query="select 1 as one", params={"region": "north", "since": "2026-02-03"}, param_types={"since": "date"})
    assert spy.calls == [{"region": "north", "since": dt.date(2026, 2, 3)}]
    entry = session.history.recent(1)[0]
    assert entry["params"] == {"region": "north", "since": "2026-02-03"}


@needs_engine
def test_run_without_params_calls_sql_as_before(session: KernelSession, spy: Spy):
    call(session, "sql.run", query="select 1 as one")
    assert spy.calls == [None]
    assert "params" not in session.history.recent(1)[0]


@needs_engine
def test_failed_run_records_params_too(session: KernelSession):
    with pytest.raises(Exception):
        call(session, "sql.run", query="select * from nowhere", params={"n": 1})
    entry = session.history.recent(1)[0]
    assert entry["error"] and entry["params"] == {"n": 1}


@needs_engine
def test_explain_and_analyze_pass_params(session: KernelSession, spy: Spy):
    call(session, "sql.explain", query="select 1 as one", params={"n": 2})
    call(session, "sql.analyze", query="select 1 as one", params={"n": 3})
    assert spy.calls == [{"n": 2}, {"n": 3}]
    assert session.history.recent(1)[0]["params"] == {"n": 3}


@needs_engine
def test_named_placeholders_run(session: KernelSession):
    out = call(session, "sql.run", query="select count(*) as n from sales where grp = :g and amount > :min", params={"g": 3, "min": 400})
    assert out["type"] == "table" and out["result"]["num_rows"] == 1
    # grp 3: ids 3, 10, ...; amount (id / 2) > 400 means id > 800
    assert out["result"]["page"]["rows"][0][0] == len([i for i in range(1000) if i % 7 == 3 and i * 0.5 > 400])


@needs_engine
def test_explain_with_placeholders(session: KernelSession):
    plan = call(session, "sql.explain", query="select * from sales where grp = :g", params={"g": 1})
    assert plan["text"].strip()
