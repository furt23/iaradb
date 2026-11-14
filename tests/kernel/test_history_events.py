"""History events: each run the kernel makes is reported to the Studio as a ``history`` event."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

import iara as ia
from iara.kernel.history import History
from iara.kernel.session import KernelSession

needs_write_log = pytest.mark.skipif(not hasattr(ia, "take_writes"), reason="engine build without the write log")
SETUP = {"id": "setup", "kind": "python", "code": "import iara as ia\nws = ia.workspace()"}


@pytest.fixture()
def session(workspace: Path):
    cwd = os.getcwd()
    s = KernelSession(workspace)
    yield s
    os.chdir(cwd)


@pytest.fixture()
def delta_session(workspace: Path):
    """A session with a Delta table ``events`` (two commits) next to the ``sales`` Parquet table."""
    cwd = os.getcwd()
    ia.read_parquet(str(workspace / "data" / "sales.parquet")).head(10).write_delta(str(workspace / "data" / "events"), mode="overwrite")
    ia.read_parquet(str(workspace / "data" / "sales.parquet")).head(5).write_delta(str(workspace / "data" / "events"), mode="append")
    with (workspace / "iara.toml").open("a") as f:
        f.write('\n[tables.events]\npath = "data/events"\nformat = "delta"\n')
    s = KernelSession(workspace)
    yield s
    os.chdir(cwd)


def emitter(events: list[tuple[str, dict[str, Any]]]):
    return lambda name, data: events.append((name, data))


def history_of(events: list[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    return [data for name, data in events if name == "history"]


def py(cid: str, code: str) -> dict[str, Any]:
    return {"id": cid, "kind": "python", "code": code}


def run_cells(session: KernelSession, cells: list[dict[str, Any]]) -> list[tuple[str, dict[str, Any]]]:
    events: list[tuple[str, dict[str, Any]]] = []
    session.handlers()["notebook.run"]({"cells": cells, "cell_ids": None}, emitter(events))
    return events


def test_sql_run_emits_one_history_event(session: KernelSession):
    events: list[tuple[str, dict[str, Any]]] = []
    session.handlers()["sql.run"]({"query": "select grp, count(*) as n from sales group by grp", "source": "sql editor"}, emitter(events))
    [entry] = history_of(events)
    assert entry["kind"] == "sql" and entry["source"] == "sql editor"
    assert entry["query"].startswith("select grp") and entry["rows"] == 7 and entry["error"] is None
    assert entry["ts"] > 0 and entry["elapsed_ms"] >= 0
    assert {"memory_peak", "spilled_bytes", "requests", "reads", "writes"} <= set(entry)
    assert "params" not in entry


def test_a_failing_query_emits_one_event_with_its_error(session: KernelSession):
    events: list[tuple[str, dict[str, Any]]] = []
    with pytest.raises(Exception, match="nope"):
        session.handlers()["sql.run"]({"query": "select nope from sales"}, emitter(events))
    [entry] = history_of(events)
    assert entry["rows"] is None and "nope" in entry["error"]


def test_a_python_cell_without_tables_emits_no_event(session: KernelSession):
    session.notebook.create("notebooks/history-none.py")
    events = run_cells(session, [SETUP, py("calc", "x = 1 + 1\nx")])
    assert history_of(events) == []


@needs_write_log
def test_an_insert_select_reads_and_writes_a_table(delta_session: KernelSession):
    events: list[tuple[str, dict[str, Any]]] = []
    delta_session.handlers()["sql.run"]({"query": "insert into events select * from sales where id < 3"}, emitter(events))
    [entry] = history_of(events)
    assert [r["table"] for r in entry["reads"]] == ["demo.main.sales"]
    assert [w["table"] for w in entry["writes"]] == ["demo.main.events"]
    assert entry["writes"][0]["operation"]


@needs_write_log
def test_a_python_cell_that_reads_then_writes_emits_one_python_event(delta_session: KernelSession):
    delta_session.notebook.create("notebooks/history-io.py")
    cells = [
        SETUP,
        py("copy", "ws.sql('insert into events select * from sales where id < 3').collect()\n1"),
    ]
    events = run_cells(delta_session, cells)
    [entry] = [h for h in history_of(events) if h["kind"] == "python"]
    assert entry["rows"] is None and entry["source"]
    assert [r["table"] for r in entry["reads"]] == ["demo.main.sales"]
    assert [w["table"] for w in entry["writes"]] == ["demo.main.events"]


@needs_write_log
def test_extract_returns_versions_of_delta_reads(delta_session: KernelSession, tmp_path: Path):
    out = tmp_path / "events.parquet"
    result = delta_session.handlers()["extract.write"](
        {"query": "select * from events", "path": str(out), "allow": ["demo.main.events"], "max_bytes": 1 << 20},
        lambda *a: None,
    )
    assert isinstance(result["versions"]["demo.main.events"], int)


@needs_write_log
def test_extract_pins_no_versions_when_the_query_reads_the_clock(delta_session: KernelSession, tmp_path: Path):
    result = delta_session.handlers()["extract.write"](
        {
            "query": "select * from events where current_date >= date '2020-01-01'",
            "path": str(tmp_path / "recent.parquet"),
            "allow": ["demo.main.events"],
            "max_bytes": 1 << 20,
        },
        lambda *a: None,
    )
    assert result["versions"] is None


def test_drain_returns_the_pending_entries_once():
    history = History()
    history.record("select 1", "t", 1.0, 1)
    history.record("select 2", "t", 2.0, None, error="boom")
    assert [e["query"] for e in history.drain()] == ["select 1", "select 2"]
    assert history.drain() == []
