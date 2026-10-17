"""Catalogs: ``[catalogs.<c>]`` in ``iara.toml``, ``catalog.schema.table`` names, the
statements that create, drop and select catalogs, and the sessions that hold them.

A workspace's own tables belong to its default catalog, named after ``[workspace] name``.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import iara as ia
from iara.kernel import catalog
from iara.workspaces import (
    CONFIG_NAME,
    add_table,
    catalog_entry,
    drop_target,
    normalize_catalog_name,
    parse_config,
    schema_entry,
    table_entry,
)


def _parquet(path: Path, rows: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.table({"id": list(range(rows))}), path)


def _count(ws, name: str) -> int:
    return ws.sql(f"select count(*) as n from {name}").collect().to_pydict()["n"][0]


CATALOGS = """
[workspace]
name = "tpch_demo"

[tables.orders]
path = "data/orders.parquet"

[schemas.tpch]

[catalogs.sales]
description = "Sales figures"

[catalogs.sales.schemas.raw]
description = "Raw files"
location = "lake/raw"

[catalogs.sales.tables.orders]
path = "data/sales_orders.parquet"

[catalogs.sales.tables.raw.events]
path = "data/events.parquet"

[catalogs.sales.tables.mart]

[catalogs.Archive]
"""


def _data(root: Path) -> None:
    _parquet(root / "data" / "orders.parquet", 3)
    _parquet(root / "data" / "sales_orders.parquet", 4)
    _parquet(root / "data" / "events.parquet", 5)
    _parquet(root / "lake" / "raw" / "clicks" / "part.parquet", 6)


# -- iara.toml ------------------------------------------------------------------


def test_catalog_sections_declare_catalogs_with_their_schemas_and_tables(tmp_path: Path) -> None:
    ws = parse_config(CATALOGS, tmp_path)
    assert ws.name == "tpch_demo" and ws.default_catalog == "tpch_demo"
    assert ws.catalogs == {"sales": "Sales figures", "archive": ""}
    assert ws.catalog_names == ["tpch_demo", "archive", "sales"]
    assert [(t.name, t.catalog) for t in ws.tables] == [("orders", None), ("sales.main.orders", "sales"), ("sales.raw.events", "sales")]
    assert ws.declared_schemas == {"tpch": "", "sales.raw": "Raw files", "sales.mart": ""}
    assert ws.schema_locations == {"sales.raw": str(tmp_path / "lake" / "raw")}
    assert ws.schemas == ["main", "tpch"]
    assert ws.schemas_of("sales") == ["main", "mart", "raw"] and ws.schemas_of("archive") == ["main"]
    assert ws.schemas_of("tpch_demo") == ws.schemas


def test_tables_are_found_by_any_name_that_reaches_them(tmp_path: Path) -> None:
    ws = parse_config(CATALOGS, tmp_path)
    assert ws.spec("SALES.main.Orders") is ws.spec("sales.main.orders") is not None
    assert ws.spec("orders") is ws.spec("tpch_demo.main.orders") is ws.spec("main.orders")
    assert ws.spec("orders").catalog is None and ws.spec("sales.main.orders").catalog == "sales"
    assert Path(ws.spec("sales.raw.events").path) == tmp_path / "data" / "events.parquet"
    assert ws.spec("sales.orders") is None  # that is schema `sales` of the default catalog
    assert ws.spec("a.b.c.d") is None and ws.spec("ghost.main.orders") is None


@pytest.mark.parametrize(
    "name, expected",
    [
        ("tpch_demo", "tpch_demo"),
        ("tpch-demo", "tpch_demo"),
        ("Iara Team", "iara_team"),
        ("sales-2024", "sales_2024"),
        ("Équipe", "_quipe"),
        ("   ", "___"),
        ("2024 data", "_2024_data"),
        ("😀x", "__x"),  # two UTF-16 units, as the Studio counts them
        ("", "main"),
    ],
)
def test_the_default_catalog_is_the_normalized_workspace_name(name: str, expected: str) -> None:
    assert normalize_catalog_name(name) == expected


def test_the_default_catalog_is_named_after_the_workspace_or_its_folder(tmp_path: Path) -> None:
    assert parse_config('[workspace]\nname = "My Demo-1"\n', tmp_path).default_catalog == "my_demo_1"
    assert parse_config("", tmp_path / "Team Data").default_catalog == "team_data"
    assert parse_config("", tmp_path / "Team Data").name == "Team Data"


@pytest.mark.parametrize(
    "text, match",
    [
        ('[catalogs."my-cat"]\n', "invalid catalog name"),
        ('[workspace]\nname = "w"\n[catalogs.w]\n', "default catalog"),
        ('[workspace]\nname = "Team A"\n[catalogs.TEAM_A]\n', "default catalog"),
        ("[catalogs.Sales]\n[catalogs.sales]\n", "defined twice"),
        ("catalogs = 1\n", "expected sections"),
        ("catalogs.sales = 1\n", "expected a section"),
        ('[catalogs.sales.schemas.main]\nlocation = "x"\n', "main cannot have a location"),
        ('[catalogs.sales.schemas."my-schema"]\n', "invalid schema name"),
        ('[catalogs.sales.tables.x]\nformat = "csv"\n', "no 'path'"),
        ('[catalogs.sales.tables."a.b.c"]\npath = "x"\n', "invalid table name"),
        ('[catalogs.sales.tables.s]\npath = "x"\n[catalogs.sales.tables.s.t]\npath = "y"\n', "both a table and a schema"),
    ],
)
def test_invalid_catalog_sections_are_refused(text: str, match: str, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match=match):
        parse_config(text, tmp_path)


def test_a_table_name_is_unique_across_catalogs_but_not_across_their_schemas(tmp_path: Path) -> None:
    text = (
        '[tables.t]\npath = "a.parquet"\n\n[catalogs.x.tables.t]\npath = "b.parquet"\n\n'
        '[catalogs.y.tables.t]\npath = "c.parquet"\n\n[catalogs.y.tables.s.t]\npath = "d.parquet"\n'
    )
    ws = parse_config(text, tmp_path)
    assert [t.name for t in ws.tables] == ["t", "x.main.t", "y.main.t", "y.s.t"]


def test_writers_emit_the_contract_sections() -> None:
    assert table_entry("sales.raw.events", "lake/e") == '\n[catalogs.sales.tables.raw.events]\npath = "lake/e"\n'
    assert table_entry("sales.main.orders", "o", "delta") == '\n[catalogs.sales.tables.orders]\npath = "o"\nformat = "delta"\n'
    assert table_entry("tpch.lineitem", "l") == '\n[tables.tpch.lineitem]\npath = "l"\n'
    assert schema_entry("sales.raw") == "\n[catalogs.sales.schemas.raw]\n"
    assert catalog_entry("sales") == "\n[catalogs.sales]\n"
    assert catalog_entry("Sales", 'Sales "EU"') == '\n[catalogs.sales]\ndescription = "Sales \\"EU\\""\n'
    for bad in (lambda: catalog_entry("my-cat"), lambda: schema_entry("a.b.c"), lambda: table_entry("a.b.c.d", "x")):
        with pytest.raises(ValueError, match="invalid"):
            bad()


def test_written_sections_read_back(tmp_path: Path) -> None:
    text = (
        '[workspace]\nname = "w"\n'
        + catalog_entry("sales", "Sales")
        + schema_entry("sales.raw")
        + table_entry("sales.raw.events", "e.parquet")
        + table_entry("sales.main.orders", "o.parquet", "delta")
    )
    ws = parse_config(text, tmp_path)
    assert ws.catalogs == {"sales": "Sales"} and ws.declared_schemas == {"sales.raw": ""}
    assert [(t.name, t.format) for t in ws.tables] == [("sales.raw.events", "parquet"), ("sales.main.orders", "delta")]


def test_add_table_takes_names_in_another_catalog(tmp_path: Path) -> None:
    _parquet(tmp_path / "data" / "e.parquet", 5)
    ws = parse_config('[workspace]\nname = "w"\n\n[catalogs.sales]\n', tmp_path)
    spec, entry = add_table(ws, "sales.raw.events", "data/e.parquet")
    assert (spec.name, spec.catalog) == ("sales.raw.events", "sales")
    assert entry == '\n[catalogs.sales.tables.raw.events]\npath = "data/e.parquet"\n'
    assert entry in (tmp_path / CONFIG_NAME).read_text(encoding="utf-8")
    with pytest.raises(ValueError, match="already exists"):
        add_table(ws, "SALES.raw.events", "data/e.parquet")
    with pytest.raises(ValueError, match="catalog 'ghost' does not exist"):
        add_table(ws, "ghost.raw.events", "data/e.parquet")
    # the default catalog's own name reaches the default catalog
    own, own_entry = add_table(ws, "w.main.t", "data/e.parquet", persist=False)
    assert (own.name, own.catalog) == ("t", None) and own_entry == '\n[tables.t]\npath = "data/e.parquet"\n'
    assert _count(ws, "sales.raw.events") == 5 and ws.session.schemas("sales") == ["main", "raw"]
    assert parse_config((tmp_path / CONFIG_NAME).read_text(encoding="utf-8"), tmp_path).spec("sales.raw.events") is not None


def test_drop_targets_name_tables_schemas_and_catalogs() -> None:
    assert drop_target("DROP TABLE IF EXISTS sales.raw.events") == ("table", "sales.raw.events")
    assert drop_target('drop table "sales" . "raw"."events"') == ("table", "sales.raw.events")
    assert drop_target("drop schema sales.raw cascade") == ("schema", "sales.raw")
    assert drop_target("-- note\ndrop catalog if exists Sales cascade") == ("catalog", "Sales")
    assert drop_target("drop table t") == ("table", "t")
    assert drop_target("drop view v") is None and drop_target("select 1") is None


# -- the session wrapper -----------------------------------------------------------


def test_a_session_has_a_default_catalog() -> None:
    assert ia.SessionContext().catalogs() == ["main"]
    ctx = ia.SessionContext("tpch_demo")
    assert (ctx.default_catalog(), ctx.current_catalog(), ctx.catalogs(), ctx.schemas()) == ("tpch_demo", "tpch_demo", ["tpch_demo"], ["main"])
    ctx.sql("create catalog sales").collect()
    ctx.sql("create schema sales.raw").collect()
    assert ctx.catalogs() == ["tpch_demo", "sales"]
    assert ctx.schemas("sales") == ["main", "raw"] and ctx.schemas("tpch_demo") == ["main"] == ctx.schemas()
    with pytest.raises(ia.IaraError):
        ctx.schemas("ghost")
    with pytest.raises(ia.IaraError):
        ia.SessionContext("bad name")


def test_registered_names_are_relative_to_the_default_catalog() -> None:
    ctx = ia.SessionContext("tpch_demo")
    ctx.sql("create catalog sales").collect()
    ctx.register("t", pa.table({"a": [1]}))
    ctx.register("s.t", pa.table({"a": [1, 2]}))
    ctx.register("sales.raw.t", pa.table({"a": [1, 2, 3]}))
    assert ctx.tables() == ["s.t", "sales.raw.t", "t"]
    assert [ctx.table(n).collect().height for n in ("t", "main.t", "tpch_demo.main.t", "s.t", "sales.raw.t")] == [1, 1, 1, 2, 3]
    with pytest.raises(ia.IaraError):
        ctx.register("ghost.s.t", pa.table({"a": [1]}))
    # `table()` stays relative to the default catalog after USE CATALOG; SQL names follow the current one
    ctx.sql("use catalog sales").collect()
    assert ctx.current_catalog() == "sales" and ctx.default_catalog() == "tpch_demo"
    assert ctx.table("t").collect().height == 1 and ctx.table("sales.raw.t").collect().height == 3
    assert ctx.sql("select count(*) as n from raw.t").collect().to_pydict()["n"] == [3]
    with pytest.raises(ia.IaraError):
        ctx.sql("select * from t").collect()


def test_schema_locations_take_a_catalog_qualified_schema(tmp_path: Path) -> None:
    ctx = ia.SessionContext("tpch_demo")
    ctx.sql("create catalog sales").collect()
    ctx.sql("create schema sales.raw").collect()
    ctx.set_schema_location("sales.raw", tmp_path / "raw")
    assert ctx.schema_location("sales.raw") == str(tmp_path / "raw") and ctx.schema_location("raw") is None
    ctx.sql("create table sales.raw.t as select 1 as a").collect()
    assert (tmp_path / "raw" / "t").is_dir()


# -- a workspace's session ------------------------------------------------------------


def test_the_workspace_session_holds_every_catalog(tmp_path: Path) -> None:
    _data(tmp_path)
    ws = parse_config(CATALOGS, tmp_path)
    ctx = ws.session
    assert (ctx.default_catalog(), ctx.current_catalog()) == ("tpch_demo", "tpch_demo")
    assert ctx.catalogs() == ["tpch_demo", "archive", "sales"]
    assert ctx.schemas() == ["main", "tpch"]
    assert ctx.schemas("sales") == ["main", "mart", "raw"] and ctx.schemas("archive") == ["main"]
    assert ctx.tables() == ["orders", "sales.main.orders", "sales.raw.clicks", "sales.raw.events"]
    assert ctx.schema_location("sales.raw") == ws.schema_locations["sales.raw"]
    assert [_count(ws, n) for n in ("orders", "tpch_demo.main.orders", "sales.main.orders", "sales.raw.events", "sales.raw.clicks")] == [3, 3, 4, 5, 6]
    assert ws.table("sales.raw.events").collect().height == 5
    shown = ws.sql("show catalogs").collect().to_pydict()
    assert (shown["catalog"], shown["current"]) == (["tpch_demo", "archive", "sales"], [True, False, False])
    assert ws.sql("show schemas in sales").collect().to_pydict()["schema"] == ["main", "mart", "raw"]


def test_use_catalog_moves_sql_names_and_leaves_the_workspace_alone(tmp_path: Path) -> None:
    _data(tmp_path)
    ws = parse_config(CATALOGS, tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append
    ws.sql("use catalog sales").collect()
    assert ws.session.current_catalog() == "sales" and changes == []
    assert _count(ws, "orders") == 4 and _count(ws, "raw.events") == 5  # sales.main.orders, sales.raw.events
    assert ws.table("orders").collect().height == 3  # the default catalog's, whatever USE CATALOG says
    assert ws.spec("orders").catalog is None
    ws.sql("use catalog tpch_demo").collect()
    assert _count(ws, "orders") == 3
    ws.sql("use sales.raw").collect()  # catalog and schema in one
    assert ws.session.current_catalog() == "sales" and _count(ws, "events") == 5 and changes == []
    # a scratch fork (extra tables) starts where the session is
    assert ws.sql("select count(*) as n from events e join x using (id)", x=pa.table({"id": [1, 2]})).collect().to_pydict()["n"] == [2]


def test_a_workspace_without_catalogs_has_only_the_default_one(tmp_path: Path) -> None:
    ws = parse_config('[workspace]\nname = "Iara Team"\n', tmp_path)
    assert ws.catalogs == {} and ws.catalog_names == ["iara_team"] and ws.session.catalogs() == ["iara_team"]


# -- statements that write -----------------------------------------------------------------


def test_ctas_into_another_catalog_emits_its_section(tmp_path: Path) -> None:
    ws = parse_config('[workspace]\nname = "w"\nwarehouse = "lake"\n\n[catalogs.sales]\n', tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append
    ws.session.register("src", pa.table({"id": [1, 2, 3]}))

    ws.sql("create schema sales.raw").collect()
    assert changes == [{"name": "sales.raw", "entry": "\n[catalogs.sales.schemas.raw]\n", "kind": "schema"}]

    ws.sql("create table sales.raw.events as select * from src").collect()
    assert changes[-1] == {
        "name": "sales.raw.events",
        "entry": '\n[catalogs.sales.tables.raw.events]\npath = "lake/_catalogs/sales/raw/events"\nformat = "delta"\n',
        "kind": "table",
    }
    ws.sql("create table sales.main.orders as select * from src").collect()
    assert changes[-1] == {
        "name": "sales.main.orders",
        "entry": '\n[catalogs.sales.tables.orders]\npath = "lake/_catalogs/sales/main/orders"\nformat = "delta"\n',
        "kind": "table",
    }
    assert (tmp_path / "lake" / "_catalogs" / "sales" / "raw" / "events").is_dir()
    assert [(t.name, t.catalog) for t in ws.tables] == [("sales.raw.events", "sales"), ("sales.main.orders", "sales")]
    assert ws.schemas_of("sales") == ["main", "raw"] and _count(ws, "sales.raw.events") == 3
    # what was emitted reads back as the same catalog
    fresh = parse_config('[workspace]\nname = "w"\n\n[catalogs.sales]\n' + "".join(c["entry"] for c in changes), tmp_path)
    assert [t.name for t in fresh.tables] == ["sales.raw.events", "sales.main.orders"] and list(fresh.declared_schemas) == ["sales.raw"]
    # a table of the default catalog keeps its plain section
    ws.sql("create table tpch_like as select * from src").collect()
    assert changes[-1]["name"] == "tpch_like" and changes[-1]["entry"].startswith("\n[tables.tpch_like]\n")
    # the current catalog is where unqualified names go
    ws.sql("use catalog sales").collect()
    ws.sql("create table later as select * from main.orders").collect()
    assert changes[-1]["name"] == "sales.main.later" and changes[-1]["entry"].startswith("\n[catalogs.sales.tables.later]\n")


def test_tables_made_on_a_scratch_fork_reach_the_main_session(tmp_path: Path) -> None:
    ws = parse_config('[workspace]\nname = "w"\nwarehouse = "lake"\n\n[catalogs.sales]\n', tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append
    frame = pa.table({"id": [1, 2, 3]})

    ws.sql("create table sales.main.copy as select * from df", df=frame).collect()
    assert changes[-1]["name"] == "sales.main.copy" and _count(ws, "sales.main.copy") == 3
    ws.sql("insert into sales.main.copy select * from df", df=frame).collect()
    assert _count(ws, "sales.main.copy") == 6 and len(changes) == 1
    ws.sql("drop table sales.main.copy", df=frame).collect()
    assert changes[-1] == {"name": "sales.main.copy", "entry": None, "kind": "table"}
    assert ws.tables == [] and "sales.main.copy" not in ws.session.tables()


def test_create_catalog_is_declared_once(tmp_path: Path) -> None:
    ws = parse_config('[workspace]\nname = "w"\n\n[catalogs.declared]\n', tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append
    ws.sql("create catalog sales").collect()
    assert changes == [{"name": "sales", "entry": "\n[catalogs.sales]\n", "kind": "catalog"}]
    assert ws.catalogs == {"declared": "", "sales": ""} and ws.session.catalogs() == ["w", "declared", "sales"]
    ws.sql("create catalog if not exists sales").collect()
    ws.sql("create catalog if not exists declared").collect()
    ws.sql("create catalog if not exists w").collect()
    assert len(changes) == 1
    with pytest.raises(ia.IaraError):
        ws.sql("create catalog sales").collect()
    assert len(changes) == 1


def test_drop_catalog_cascade_drops_its_tables_and_schemas_in_order(tmp_path: Path) -> None:
    _data(tmp_path)
    text = (
        '[workspace]\nname = "w"\n\n[tables.orders]\npath = "data/orders.parquet"\n\n'
        '[catalogs.sales]\n\n[catalogs.sales.schemas.raw]\n\n[catalogs.sales.schemas.mart]\n\n'
        '[catalogs.sales.tables.orders]\npath = "data/sales_orders.parquet"\n\n'
        '[catalogs.sales.tables.raw.events]\npath = "data/events.parquet"\n\n'
        '[catalogs.other.tables.x]\npath = "data/orders.parquet"\n'
    )
    ws = parse_config(text, tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append

    ws.sql("drop catalog sales cascade").collect()
    assert changes == [
        {"name": "sales.main.orders", "entry": None, "kind": "table"},
        {"name": "sales.raw.events", "entry": None, "kind": "table"},
        {"name": "sales.raw", "entry": None, "kind": "schema"},
        {"name": "sales.mart", "entry": None, "kind": "schema"},
        {"name": "sales", "entry": None, "kind": "catalog"},
    ]
    assert [t.name for t in ws.tables] == ["orders", "other.main.x"]
    assert ws.catalogs == {"other": ""} and ws.declared_schemas == {} and ws.session.catalogs() == ["w", "other"]
    assert _count(ws, "orders") == 3 and _count(ws, "other.main.x") == 3


def test_drop_catalog_without_cascade_needs_it_empty(tmp_path: Path) -> None:
    _data(tmp_path)
    text = '[workspace]\nname = "w"\n\n[catalogs.full.tables.t]\npath = "data/orders.parquet"\n\n[catalogs.empty]\n'
    ws = parse_config(text, tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append
    for query in ("drop catalog full", "drop catalog full restrict", "drop catalog w", "drop catalog w cascade", "drop catalog ghost"):
        with pytest.raises(ia.IaraError):
            ws.sql(query).collect()
    assert changes == [] and ws.catalogs == {"full": "", "empty": ""}

    ws.sql("drop catalog empty").collect()
    assert changes == [{"name": "empty", "entry": None, "kind": "catalog"}] and ws.catalogs == {"full": ""}
    ws.sql("drop catalog if exists ghost").collect()
    ws.sql("drop catalog if exists empty").collect()
    assert len(changes) == 1


def test_a_catalog_made_by_a_statement_survives_a_rebuilt_session(tmp_path: Path) -> None:
    ws = parse_config('[workspace]\nname = "w"\nwarehouse = "lake"\n', tmp_path)
    ws.sql("create catalog sales").collect()
    ws.sql("create schema sales.raw").collect()
    ws.sql("create table sales.raw.t as select 1 as a").collect()
    ws._session = None  # what the kernel does when the Studio sends the catalog again
    assert ws.session.catalogs() == ["w", "sales"] and ws.session.schemas("sales") == ["main", "raw"] and _count(ws, "sales.raw.t") == 1


# -- schema locations in another catalog ----------------------------------------------------


def test_a_schema_location_in_another_catalog_is_discovered(tmp_path: Path) -> None:
    _data(tmp_path)
    _parquet(tmp_path / "lake" / "raw" / "views" / "part.parquet", 2)
    ws = parse_config(CATALOGS, tmp_path)
    ws.session
    assert sorted(t.name for t in ws.discovered) == ["sales.raw.clicks", "sales.raw.views"]
    assert {t.catalog for t in ws.discovered} == {"sales"} and _count(ws, "sales.raw.views") == 2
    assert ws.schemas_of("sales") == ["main", "mart", "raw"] and ws.spec("SALES.raw.CLICKS") is not None
    listed = {t["name"]: t for t in catalog.list_tables(ws)}
    assert listed["sales.raw.clicks"]["catalog"] == "sales" and "catalog" not in listed["orders"]

    # a folder that appears becomes a table, one that vanishes leaves
    _parquet(tmp_path / "lake" / "raw" / "fresh" / "part.parquet", 7)
    shutil.rmtree(tmp_path / "lake" / "raw" / "views")
    assert ws.refresh() is True
    assert sorted(t.name for t in ws.discovered) == ["sales.raw.clicks", "sales.raw.fresh"] and _count(ws, "sales.raw.fresh") == 7
    with pytest.raises(ia.IaraError):
        _count(ws, "sales.raw.views")
    assert ws.refresh() is False


def test_an_explicit_table_wins_over_a_discovered_one(tmp_path: Path) -> None:
    _data(tmp_path)
    text = CATALOGS + '\n[catalogs.sales.tables.raw.clicks]\npath = "data/events.parquet"\n'
    ws = parse_config(text, tmp_path)
    assert ws.session and ws.discovered == [] and _count(ws, "sales.raw.clicks") == 5


def test_ctas_in_a_located_schema_of_another_catalog_is_discovered_not_declared(tmp_path: Path) -> None:
    _data(tmp_path)
    ws = parse_config(CATALOGS, tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append
    declared = [t.name for t in ws.tables]
    ws.sql("create table sales.raw.made as select 1 as a").collect()
    assert changes == [{"name": "sales.raw", "entry": None, "kind": "refresh"}]
    assert (tmp_path / "lake" / "raw" / "made").is_dir()
    assert "sales.raw.made" in [t.name for t in ws.discovered] and [t.name for t in ws.tables] == declared
    assert _count(ws, "sales.raw.made") == 1
    ws.sql("alter table sales.raw.made add column b int").collect()
    assert changes[-1] == {"name": "sales.raw", "entry": None, "kind": "refresh"}


def test_discovered_tables_cannot_be_dropped(tmp_path: Path) -> None:
    _data(tmp_path)
    ws = parse_config(CATALOGS, tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append
    with pytest.raises(ValueError, match="sales.raw.clicks is the folder"):
        ws.sql("drop table sales.raw.clicks").collect()
    with pytest.raises(ValueError, match="schema sales.raw has a location"):
        ws.sql("drop schema sales.raw cascade").collect()
    with pytest.raises(ValueError, match="catalog sales has schemas with a location"):
        ws.sql("drop catalog sales cascade").collect()
    # names that lean on the current catalog and schema are the same tables
    ws.sql("use catalog sales").collect()
    with pytest.raises(ValueError, match="sales.raw.clicks is the folder"):
        ws.sql("drop table raw.clicks").collect()
    ws.sql("use raw").collect()
    with pytest.raises(ValueError, match="sales.raw.clicks is the folder"):
        ws.sql("drop table if exists clicks").collect()
    with pytest.raises(ValueError, match="schema sales.raw has a location"):
        ws.sql("drop schema raw").collect()
    assert changes == [] and _count(ws, "sales.raw.clicks") == 6
    # the explicit tables of the same catalog can still go
    ws.sql("drop table sales.main.orders").collect()
    assert changes == [{"name": "sales.main.orders", "entry": None, "kind": "table"}]
