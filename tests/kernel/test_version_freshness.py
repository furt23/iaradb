"""The Delta version the Studio reads for a dashboard's skip check is the log's, read again on each call."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

import iara as ia
from iara.kernel.session import KernelSession


def call(session: KernelSession, method: str, params: dict[str, Any]) -> Any:
    return session.handlers()[method](params, lambda *a: None)


def latest_version(session: KernelSession, table: str) -> int:
    return call(session, "catalog.history", {"table": table, "limit": 1})[0]["version"]


@pytest.fixture()
def events(workspace: Path):
    cwd = os.getcwd()
    ia.read_parquet(str(workspace / "data" / "sales.parquet")).head(10).write_delta(str(workspace / "data" / "events"), mode="overwrite")
    with (workspace / "iara.toml").open("a") as f:
        f.write('\n[tables.events]\npath = "data/events"\nformat = "delta"\n')
    yield workspace / "data" / "events"
    os.chdir(cwd)


def test_latest_version_follows_a_commit_made_elsewhere(workspace: Path, events: Path):
    s = KernelSession(workspace)
    full = call(s, "catalog.table", {"name": "events"})["full"]  # the name a version check passes: catalog.schema.table
    assert latest_version(s, full) == 0
    # the table is loaded by this session first: a version read from that copy would stay at 0
    call(s, "catalog.table", {"name": "events"})

    # another process commits to the table
    ia.read_parquet(str(workspace / "data" / "sales.parquet")).head(5).write_delta(str(events), mode="append")

    assert latest_version(s, full) == 1
    assert call(s, "catalog.table", {"name": "events"})["version"] == 1
