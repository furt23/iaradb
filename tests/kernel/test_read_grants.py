"""Read grants of the SQL editor: a request's ``allow`` list limits what its query may read."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from iara.kernel.session import KernelSession


@pytest.fixture()
def session(workspace: Path):
    cwd = os.getcwd()
    s = KernelSession(workspace)
    yield s
    os.chdir(cwd)


def call(session: KernelSession, method: str, params: dict[str, Any]) -> Any:
    return session.handlers()[method](params, lambda *a: None)


def test_run_reads_a_table_the_allow_list_covers(session: KernelSession):
    out = call(session, "sql.run", {"query": "select count(*) as n from sales", "allow": ["demo.main.sales"]})
    assert out["type"] == "table" and out["result"]["page"]["rows"][0][0] == 1000


def test_run_refuses_an_uncovered_table(session: KernelSession):
    with pytest.raises(Exception, match="no read grant"):
        call(session, "sql.run", {"query": "select count(*) from regions", "allow": ["demo.main.sales"]})


def test_an_empty_allow_list_reads_nothing(session: KernelSession):
    with pytest.raises(Exception, match="no read grant"):
        call(session, "sql.run", {"query": "select count(*) from sales", "allow": []})


def test_a_write_with_allow_raises(session: KernelSession):
    with pytest.raises(PermissionError, match="only queries are allowed here"):
        call(session, "sql.run", {"query": "create table big_sales as select * from sales", "allow": ["*"]})


def test_without_allow_everything_reads_as_before(session: KernelSession):
    out = call(session, "sql.run", {"query": "select count(*) as n from sales"})
    assert out["result"]["page"]["rows"][0][0] == 1000
    out = call(session, "sql.run", {"query": "select count(*) as n from regions"})
    assert out["result"]["page"]["rows"][0][0] == 4


def test_catalog_list_carries_the_full_name(session: KernelSession):
    tables = {t["name"]: t["full"] for t in call(session, "catalog.list", {})}
    assert tables == {"sales": "demo.main.sales", "regions": "demo.main.regions"}
