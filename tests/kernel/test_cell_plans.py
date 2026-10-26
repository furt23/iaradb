"""Cells keep the plans of the engine queries they ran: the Studio draws them."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from iara.kernel.session import KernelSession

SETUP = {"id": "setup", "kind": "python", "code": "import iara as ia\nws = ia.workspace()"}
GROUPED = "select grp, count(*) as n from sales group by grp"


@pytest.fixture()
def session(workspace: Path):
    cwd = os.getcwd()
    s = KernelSession(workspace)
    yield s
    os.chdir(cwd)


def py(cid: str, code: str) -> dict[str, Any]:
    return {"id": cid, "kind": "python", "code": code}


def run(session: KernelSession, cells: list[dict[str, Any]], targets: list[str] | None = None) -> None:
    session.notebook.run(cells, targets, lambda *a: None)


def queries(session: KernelSession, cid: str) -> list[dict[str, Any]]:
    return session.notebook.view()["states"][cid]["queries"]


def test_a_python_cell_keeps_the_plans_of_its_queries(session: KernelSession):
    session.notebook.create("notebooks/plans.py")
    run(session, [SETUP, py("big", "big = ws.sql('select grp, count(*) as n from sales group by grp').collect()\nbig.height")])
    [q] = queries(session, "big")
    assert q["query"] == "" and q["rows"] == 7 and isinstance(q["at"], int)
    assert q["text"].strip() and q["profile"]["pipelines"]
    assert q["plan"]["name"] and q["plan"]["metrics"]["rows_out"] >= 0


def test_an_sql_cell_keeps_its_query_text(session: KernelSession):
    session.notebook.create("notebooks/plans-sql.py")
    run(session, [{"id": "agg", "kind": "sql", "code": GROUPED, "output": "agg"}])
    [q] = queries(session, "agg")
    assert q["query"] == GROUPED and q["rows"] == 7
    assert q["plan"]["metrics"]["rows_out"] >= 0


def test_cells_without_queries_have_none(session: KernelSession):
    session.notebook.create("notebooks/plans-none.py")
    run(session, [SETUP, {"id": "md", "kind": "markdown", "code": "# Notes"}, py("calc", "x = 1 + 1\nx")])
    assert queries(session, "md") == [] and queries(session, "calc") == []


def test_a_rerun_replaces_the_queries(session: KernelSession):
    session.notebook.create("notebooks/plans-rerun.py")
    cells = [SETUP, py("big", "big = ws.sql('select * from sales').collect()\nbig.height")]
    run(session, cells)
    run(session, cells, ["big"])
    assert len(queries(session, "big")) == 1


def test_a_failed_cell_keeps_the_plans_of_the_queries_that_ran(session: KernelSession):
    session.notebook.create("notebooks/plans-error.py")
    run(session, [SETUP, py("bad", "ws.sql('select * from sales').collect()\n1 / 0")])
    state = session.notebook.view()["states"]["bad"]
    assert state["status"] == "error" and len(state["queries"]) == 1


def test_a_cell_keeps_its_last_ten_queries(session: KernelSession):
    session.notebook.create("notebooks/plans-loop.py")
    loop = "for i in range(12):\n    ws.sql(f'select * from sales limit {i + 1}').collect()"
    run(session, [SETUP, py("loop", loop)])
    assert [q["rows"] for q in queries(session, "loop")] == list(range(3, 13))


def test_clearing_a_cell_drops_its_queries(session: KernelSession):
    session.notebook.create("notebooks/plans-clear.py")
    run(session, [SETUP, py("big", "big = ws.sql('select * from sales').collect()\nbig.height")])
    session.notebook.clear("notebooks/plans-clear.py", ["big"])
    assert queries(session, "big") == []
