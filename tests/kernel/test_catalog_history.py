"""catalog.history: the commits of a Delta table, newest first."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

import workhouse as wh
from workhouse.kernel.session import KernelSession


def call(session: KernelSession, method: str, params: dict[str, Any]) -> Any:
    return session.handlers()[method](params, lambda *a: None)


@pytest.fixture()
def session(workspace: Path):
    cwd = os.getcwd()
    (workspace / "data" / "events").parent.mkdir(exist_ok=True)
    wh.read_parquet(str(workspace / "data" / "sales.parquet")).head(10).write_delta(str(workspace / "data" / "events"), mode="overwrite")
    wh.read_parquet(str(workspace / "data" / "sales.parquet")).head(5).write_delta(str(workspace / "data" / "events"), mode="append")
    with (workspace / "workhouse.toml").open("a") as f:
        f.write('\n[tables.events]\npath = "data/events"\nformat = "delta"\n')
    s = KernelSession(workspace)
    yield s
    os.chdir(cwd)


def test_history_lists_commits_newest_first(session: KernelSession):
    rows = call(session, "catalog.history", {"table": "events"})
    assert [r["version"] for r in rows] == [1, 0]
    assert rows[0]["timestamp"] > 0 and rows[0]["operation"]
    assert set(rows[0]) == {"version", "timestamp", "operation", "operation_parameters", "operation_metrics", "engine_info"}
    assert isinstance(rows[0]["operation_metrics"], dict)


def test_history_limit(session: KernelSession):
    assert [r["version"] for r in call(session, "catalog.history", {"table": "events", "limit": 1})] == [1]


def test_history_rejects_other_formats(session: KernelSession):
    with pytest.raises(ValueError, match="not a Delta table"):
        call(session, "catalog.history", {"table": "sales"})
    with pytest.raises(KeyError):
        call(session, "catalog.history", {"table": "nope"})
