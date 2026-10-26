"""Kernel: catalogs in the workspace info, the catalog browser and the changes sent to the Studio."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from iara.kernel.session import KernelSession

TOML = """
[workspace]
name = "Demo Team"

[tables.sales]
path = "data/sales.parquet"

[catalogs.archive]
description = "Closed years"

[catalogs.archive.tables.old]
path = "data/sales.parquet"

[catalogs.archive.tables.raw.events]
path = "data/regions.csv"
"""


class Recorder:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, event: str, data: dict[str, Any]) -> None:
        self.events.append((event, data))

    def changes(self) -> list[dict[str, Any]]:
        return [d for e, d in self.events if e == "catalog.changed"]


@pytest.fixture()
def session(workspace: Path):
    (workspace / "iara.toml").write_text(TOML, encoding="utf-8")
    cwd = os.getcwd()
    s = KernelSession(workspace)
    yield s
    os.chdir(cwd)


def call(session: KernelSession, method: str, params: dict[str, Any] | None = None) -> Any:
    return session.handlers()[method](params or {}, lambda *a: None)


def test_info_lists_the_catalogs_default_first(session: KernelSession):
    info = call(session, "workspace.info")
    assert info["name"] == "Demo Team" and info["catalogs"] == ["demo_team", "archive"]
    assert info["schemas"] == ["main"]  # the default catalog's
    assert call(session, "ping")["catalogs"] == info["catalogs"]


def test_catalog_list_names_the_catalog_of_tables_outside_the_default_one(session: KernelSession):
    tables = {t["name"]: t for t in call(session, "catalog.list")}
    assert list(tables) == ["sales", "archive.main.old", "archive.raw.events"]
    assert "catalog" not in tables["sales"]
    assert tables["archive.main.old"] == {"name": "archive.main.old", "path": "data/sales.parquet", "format": "parquet", "catalog": "archive", "full": "archive.main.old"}
    assert tables["archive.raw.events"]["format"] == "csv" and tables["archive.raw.events"]["catalog"] == "archive"


def test_the_browser_takes_the_names_the_catalog_lists(session: KernelSession):
    info = call(session, "catalog.table", {"name": "archive.main.old"})
    assert info["name"] == "archive.main.old" and info["catalog"] == "archive" and info["num_rows"] == 1000 and info["files"] == 1
    assert {s["column"]: s["max"] for s in info["stats"]}["id"] == 999
    events = call(session, "catalog.table", {"name": "archive.raw.events"})
    assert events["num_rows"] is None and [c["name"] for c in events["columns"]] == ["grp", "region"]  # a CSV is not counted
    assert "catalog" not in call(session, "catalog.table", {"name": "sales"})

    preview = call(session, "catalog.preview", {"name": "archive.raw.events", "limit": 2})
    assert preview["type"] == "table" and preview["result"]["num_rows"] == 2

    schema = call(session, "catalog.schema")
    assert set(schema) == {"sales", "archive.main.old", "archive.raw.events"}
    assert [c["name"] for c in schema["archive.raw.events"]] == ["grp", "region"]
    with pytest.raises(KeyError):
        call(session, "catalog.table", {"name": "archive.main.ghost"})


def test_the_browser_works_whatever_catalog_a_statement_selected(session: KernelSession):
    session.sql_run({"query": "use catalog archive"}, Recorder())
    assert session.ws.session.current_catalog() == "archive"
    assert call(session, "catalog.table", {"name": "sales"})["num_rows"] == 1000
    assert call(session, "catalog.table", {"name": "archive.main.old"})["num_rows"] == 1000
    assert call(session, "catalog.preview", {"name": "sales", "limit": 3})["result"]["num_rows"] == 3
    assert "sales" in call(session, "catalog.schema")


def test_history_of_a_delta_table_in_another_catalog(session: KernelSession):
    rec = Recorder()
    session.sql_run({"query": "create table archive.raw.big as select * from sales where amount > 400"}, rec)
    session.sql_run({"query": "insert into archive.raw.big select * from sales where amount > 490"}, rec)
    versions = [c["version"] for c in call(session, "catalog.history", {"table": "archive.raw.big"})]
    assert versions == [1, 0]
    with pytest.raises(ValueError, match="not a Delta table"):
        call(session, "catalog.history", {"table": "archive.main.old"})


def test_catalog_add_in_another_catalog(session: KernelSession, workspace: Path):
    before = (workspace / "iara.toml").read_text(encoding="utf-8")
    ref = call(session, "catalog.add", {"name": "archive.raw.more", "path": "data/sales.parquet", "persist": False})
    assert ref["name"] == "archive.raw.more" and ref["catalog"] == "archive"
    assert ref["entry"] == '\n[catalogs.archive.tables.raw.more]\npath = "data/sales.parquet"\n'
    assert (workspace / "iara.toml").read_text(encoding="utf-8") == before
    assert call(session, "catalog.table", {"name": "archive.raw.more"})["num_rows"] == 1000
    main = call(session, "catalog.add", {"name": "archive.main.more", "path": "data/sales.parquet", "persist": False})
    assert main["entry"].startswith("\n[catalogs.archive.tables.more]\n")
    plain = call(session, "catalog.add", {"name": "sales_copy", "path": "data/sales.parquet", "persist": False})
    assert "catalog" not in plain and plain["entry"].startswith("\n[tables.sales_copy]\n")
    with pytest.raises(ValueError, match="does not exist"):
        call(session, "catalog.add", {"name": "ghost.raw.t", "path": "data/sales.parquet", "persist": False})


def test_statements_on_catalogs_reach_the_studio(session: KernelSession):
    rec = Recorder()
    session.sql_run({"query": "create catalog scratch"}, rec)
    session.sql_run({"query": "create schema scratch.stage"}, rec)
    out = session.sql_run({"query": "create table scratch.stage.t as select * from sales where id < 5"}, rec)
    assert out["result"]["page"]["rows"][0][:2] == ["create", "scratch.stage.t"]
    assert rec.changes() == [
        {"name": "scratch", "entry": "\n[catalogs.scratch]\n", "kind": "catalog"},
        {"name": "scratch.stage", "entry": "\n[catalogs.scratch.schemas.stage]\n", "kind": "schema"},
        {
            "name": "scratch.stage.t",
            "entry": '\n[catalogs.scratch.tables.stage.t]\npath = "warehouse/_catalogs/scratch/stage/t"\nformat = "delta"\n',
            "kind": "table",
        },
    ]
    assert call(session, "workspace.info")["catalogs"] == ["demo_team", "archive", "scratch"]
    assert {t["name"]: t.get("catalog") for t in call(session, "catalog.list")}["scratch.stage.t"] == "scratch"

    rec = Recorder()
    session.sql_run({"query": "drop catalog scratch cascade"}, rec)
    assert rec.changes() == [
        {"name": "scratch.stage.t", "entry": None, "kind": "table"},
        {"name": "scratch.stage", "entry": None, "kind": "schema"},
        {"name": "scratch", "entry": None, "kind": "catalog"},
    ]
    assert call(session, "workspace.info")["catalogs"] == ["demo_team", "archive"]


def test_use_catalog_and_show_catalogs_through_the_sql_editor(session: KernelSession):
    rec = Recorder()
    out = session.sql_run({"query": "use catalog archive"}, rec)
    assert out["result"]["page"]["rows"][0][:2] == ["use catalog", "archive"] and rec.changes() == []
    shown = session.sql_run({"query": "show catalogs"}, rec)["result"]["page"]["rows"]
    assert shown == [["demo_team", False], ["archive", True]]
    assert session.sql_run({"query": "select count(*) as n from old"}, rec)["result"]["page"]["rows"] == [[1000]]


def test_configure_and_reload_take_the_catalogs_from_the_text(session: KernelSession, workspace: Path):
    toml = '[workspace]\nname = "remote"\n\n[catalogs.lake.tables.t]\npath = "data/sales.parquet"\n\n[catalogs.zeta]\n'
    info = call(session, "workspace.configure", {"toml": toml})
    assert info["name"] == "remote" and info["catalogs"] == ["remote", "lake", "zeta"]
    assert [(t["name"], t.get("catalog")) for t in info["tables"]] == [("lake.main.t", "lake")]
    assert session.ws.sql("select count(*) as n from lake.main.t").collect().item() == 1000
    assert session.ws.session.catalogs() == ["remote", "lake", "zeta"]

    plain = call(session, "workspace.configure", {"toml": '[workspace]\nname = "remote"\n'})
    assert plain["catalogs"] == ["remote"] and plain["tables"] == []
    assert session.ws.session.catalogs() == ["remote"]

    assert call(session, "workspace.reload")["catalogs"] == ["demo_team", "archive"]
