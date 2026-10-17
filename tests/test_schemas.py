"""Schemas: tables named ``schema.table`` in ``iara.toml``, the statements
that create and drop schemas, and qualified names in notebook analysis
(``catalog.schema.table`` names and catalogs: see ``test_catalogs.py``).

Tests marked ``engine_schemas`` need the engine's schema support (``CREATE
SCHEMA``, ``USE``, ``SessionContext.schemas``) and are skipped without it.
"""

from __future__ import annotations

from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import iara as ia
from iara.kernel import catalog
from iara.kernel.notebook.analysis import analyze, sql_identifiers
from iara.kernel.notebook.graph import DependencyGraph
from iara.kernel.notebook.model import Cell
from iara.sqlwrite import is_schema_statement, is_write
from iara.workspaces import CONFIG_NAME, add_table, display_name, parse_config, schema_entry, schema_of, split_name, table_entry

engine_schemas = pytest.mark.skipif(not hasattr(ia.SessionContext, "schemas"), reason="engine without schemas")


def _parquet(path: Path, rows: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.table({"id": list(range(rows))}), path)


CATALOG = """
[workspace]
name = "tpch"

[tables.lineitem]
path = "data/lineitem.parquet"

[tables.tpch.lineitem]
path = "data/tpch/lineitem.parquet"

[tables."tpch.region"]
path = "data/tpch/region.parquet"

[schemas.sales]
description = "Sales figures"
"""


# -- iara.toml -----------------------------------------------------------


def test_nested_and_quoted_sections_name_qualified_tables(tmp_path: Path) -> None:
    ws = parse_config(CATALOG, tmp_path)
    assert [t.name for t in ws.tables] == ["lineitem", "tpch.lineitem", "tpch.region"]
    assert ws.schemas == ["main", "sales", "tpch"]
    assert ws.declared_schemas == {"sales": "Sales figures"}
    assert ws.spec("TPCH.Region") is not None and ws.spec("main.lineitem").name == "lineitem"
    assert Path(ws.spec("tpch.region").path) == tmp_path / "data" / "tpch" / "region.parquet"


def test_main_prefix_names_a_main_table(tmp_path: Path) -> None:
    ws = parse_config('[tables.main.orders]\npath = "o.parquet"\n', tmp_path)
    assert [t.name for t in ws.tables] == ["orders"] and ws.schemas == ["main"]


def test_schemas_declared_with_or_without_description(tmp_path: Path) -> None:
    ws = parse_config('[schemas.sales]\ndescription = "Sales"\n\n[schemas.tpch]\n', tmp_path)
    assert ws.declared_schemas == {"sales": "Sales", "tpch": ""}
    assert ws.tables == [] and ws.schemas == ["main", "sales", "tpch"]


def test_an_empty_table_section_declares_a_schema(tmp_path: Path) -> None:
    ws = parse_config("[tables.raw]\n", tmp_path)
    assert ws.tables == [] and ws.schemas == ["main", "raw"]


def test_an_entry_cannot_be_both_table_and_schema(tmp_path: Path) -> None:
    text = '[tables.tpch]\npath = "a.parquet"\n\n[tables.tpch.lineitem]\npath = "b.parquet"\n'
    with pytest.raises(ValueError, match="tables.tpch is both a table and a schema"):
        parse_config(text, tmp_path)


@pytest.mark.parametrize(
    "text",
    [
        '[tables."tpch.line-item"]\npath = "x.parquet"\n',
        '[tables."a.b.c"]\npath = "x.parquet"\n',  # a table of another catalog is [catalogs.a.tables.b.c]
        '[tables."a.b.c.d"]\npath = "x.parquet"\n',
        '[tables."bad name"]\npath = "x.parquet"\n',
        '[tables.tpch."1x"]\npath = "x.parquet"\n',
        '[tables."../x"]\npath = "x.parquet"\n',
        '[schemas."my-schema"]\n',
    ],
)
def test_invalid_names_are_refused(text: str, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="invalid"):
        parse_config(text, tmp_path)


def test_a_table_named_twice_is_refused(tmp_path: Path) -> None:
    text = '[tables.tpch.x]\npath = "a.parquet"\n\n[tables."TPCH.X"]\npath = "b.parquet"\n'
    with pytest.raises(ValueError, match="defined twice"):
        parse_config(text, tmp_path)


def test_writers_emit_the_contract_sections() -> None:
    assert table_entry("tpch.lineitem", "data/li.parquet") == '\n[tables.tpch.lineitem]\npath = "data/li.parquet"\n'
    assert table_entry("main.orders", "data/o.parquet") == '\n[tables.orders]\npath = "data/o.parquet"\n'
    assert table_entry("orders", "s3://b/o/", "parquet") == '\n[tables.orders]\npath = "s3://b/o/"\nformat = "parquet"\n'
    assert schema_entry("tpch") == "\n[schemas.tpch]\n"


def test_names_have_up_to_three_parts_relative_to_the_default_catalog() -> None:
    assert split_name("orders", "tpch") == ("tpch", "main", "orders")
    assert split_name("Sales.Orders", "tpch") == ("tpch", "sales", "orders")
    assert split_name("Archive.Raw.Events", "tpch") == ("archive", "raw", "events")
    for name in ("a.b.c.d", "a..b", "", "a.1b", "a-b.c"):
        with pytest.raises(ValueError, match="invalid table name"):
            split_name(name, "tpch")
    # as listed: bare in main and `schema.table` in the default catalog, always three parts in the others
    assert [display_name(n, "tpch") for n in ("orders", "main.orders", "tpch.main.orders", "tpch.sales.orders", "sales.orders")] == [
        "orders",
        "orders",
        "orders",
        "sales.orders",
        "sales.orders",
    ]
    assert display_name("archive.main.orders", "tpch") == "archive.main.orders"
    assert [schema_of(t) for t in ("orders", "sales.orders", "archive.raw.events")] == ["main", "sales", "archive.raw"]


def test_written_sections_read_back(tmp_path: Path) -> None:
    text = '[workspace]\nname = "w"\n' + table_entry("tpch.lineitem", "x.parquet") + schema_entry("sales")
    ws = parse_config(text, tmp_path)
    assert [t.name for t in ws.tables] == ["tpch.lineitem"] and ws.schemas == ["main", "sales", "tpch"]


def test_add_table_takes_qualified_names(tmp_path: Path) -> None:
    _parquet(tmp_path / "data" / "region.parquet", 5)
    ws = parse_config('[workspace]\nname = "w"\n', tmp_path)
    spec, entry = add_table(ws, "tpch.region", "data/region.parquet")
    assert spec.name == "tpch.region"
    assert entry == '\n[tables.tpch.region]\npath = "data/region.parquet"\n'
    assert "[tables.tpch.region]" in (tmp_path / CONFIG_NAME).read_text(encoding="utf-8")
    assert ws.schemas == ["main", "tpch"]
    with pytest.raises(ValueError, match="already exists"):
        add_table(ws, "TPCH.region", "data/region.parquet")


# -- queries over qualified tables (no engine schema support needed) ------------


def test_a_qualified_table_is_queried_by_its_full_name(tmp_path: Path) -> None:
    _parquet(tmp_path / "data" / "tpch" / "region.parquet", 5)
    ws = parse_config('[workspace]\nname = "w"\n\n[tables.tpch.region]\npath = "data/tpch/region.parquet"\n', tmp_path)
    assert ws.sql("select count(*) as n from tpch.region").collect().to_pydict()["n"] == [5]
    info = catalog.table_info(ws, "tpch.region")
    assert info["name"] == "tpch.region" and info["num_rows"] == 5 and info["files"] == 1
    assert [c["name"] for c in info["columns"]] == ["id"]
    assert [t["name"] for t in catalog.list_tables(ws)] == ["tpch.region"]
    assert "tpch.region" in catalog.schemas(ws)


# -- statements -----------------------------------------------------------------


@pytest.mark.parametrize(
    "query",
    [
        "create schema tpch",
        "  -- note\n CREATE SCHEMA IF NOT EXISTS tpch",
        "DROP SCHEMA tpch CASCADE",
        "use tpch",
        "USE main",
        "copy (select 1) to 'x.parquet'",
        "create table tpch.t as select 1 as x",
        "insert into tpch.t select 1",
        "drop table tpch.t",
        "create table sales.tpch.t as select 1 as x",
        "CREATE CATALOG sales",
        "drop catalog if exists sales cascade",
        "USE CATALOG sales",
    ],
)
def test_statements_that_write_are_routed(query: str) -> None:
    assert is_write(query)


@pytest.mark.parametrize(
    "query",
    [
        "create schema tpch",
        "drop schema tpch cascade",
        "use tpch",
        "/* c */ USE tpch",
        "create schema sales.raw",
        "CREATE CATALOG IF NOT EXISTS sales",
        "-- note\n drop catalog sales cascade",
        "use catalog sales",
        "USE sales.raw",
    ],
)
def test_schema_statements_run_on_the_session(query: str) -> None:
    assert is_schema_statement(query)


@pytest.mark.parametrize(
    "query", ["select 1", "select * from users", "use_it as x", "create table t as select 1", "show catalogs", "create table catalog.s.t as select 1"]
)
def test_other_statements_are_not_schema_statements(query: str) -> None:
    assert not is_schema_statement(query)


@pytest.mark.parametrize("query", ["select 1", "select * from users", "use_it as x", "show catalogs", "show schemas in sales", "show tables"])
def test_reads_are_not_writes(query: str) -> None:
    assert not is_write(query)


# -- notebook analysis ------------------------------------------------------------


def _cell(code: str, kind: str = "python", output: str | None = None, cid: str = "c") -> Cell:
    return Cell(cid, kind, code, output=output)


def test_dotted_names_are_one_name() -> None:
    ids = sql_identifiers("select * from tpch.lineitem join lineitem using (id)")
    assert {"tpch.lineitem", "lineitem"} <= ids and "tpch" not in ids
    assert "tpch.lineitem" in sql_identifiers('select * from "tpch" . "lineitem"')
    assert not {"tpch.lineitem", "tpch"} & sql_identifiers("select 'tpch.lineitem' as x -- tpch.lineitem")


def test_a_qualified_reference_is_not_a_cell_reference() -> None:
    cells = [
        _cell("lineitem = [1, 2]", cid="py"),
        _cell("select count(*) as n from tpch.lineitem", "sql", "n", cid="qualified"),
        _cell("select count(*) as m from main.lineitem", "sql", "m", cid="main"),
        _cell("select count(*) as k from lineitem", "sql", "k", cid="plain"),
    ]
    g = DependencyGraph(cells)
    assert g.deps["qualified"].parents == frozenset()
    assert g.deps["main"].parents == frozenset()
    assert g.deps["plain"].parents == {"py"}
    assert "tpch.lineitem" in analyze(cells[1]).sql_idents


def test_a_three_part_reference_is_one_name_and_not_a_cell_reference() -> None:
    ids = sql_identifiers('select * from sales.raw.events join "sales" . "main" . "orders" using (id)')
    assert {"sales.raw.events", "sales.main.orders"} <= ids and not {"sales", "raw", "events"} & ids
    cells = [_cell("events = [1]", cid="py"), _cell("select count(*) as n from sales.raw.events", "sql", "n", cid="q")]
    assert DependencyGraph(cells).deps["q"].parents == frozenset()


# -- engine with schemas ----------------------------------------------------------


@engine_schemas
def test_qualified_names_do_not_resolve_by_their_last_part(tmp_path: Path) -> None:
    _parquet(tmp_path / "data" / "lineitem.parquet", 3)
    _parquet(tmp_path / "data" / "tpch" / "lineitem.parquet", 5)
    text = (
        '[tables.lineitem]\npath = "data/lineitem.parquet"\n\n'
        '[tables.tpch.lineitem]\npath = "data/tpch/lineitem.parquet"\n'
    )
    ws = parse_config(text, tmp_path)
    assert ws.sql("select count(*) as n from tpch.lineitem").collect().to_pydict()["n"] == [5]
    assert ws.sql("select count(*) as n from lineitem").collect().to_pydict()["n"] == [3]


@engine_schemas
def test_declared_schemas_exist_before_they_have_tables(tmp_path: Path) -> None:
    ws = parse_config('[schemas.sales]\ndescription = "Sales"\n', tmp_path)
    assert ws.session.schemas() == ["main", "sales"]


@engine_schemas
def test_ctas_into_a_schema_joins_the_catalog(tmp_path: Path) -> None:
    ws = parse_config('[workspace]\nname = "w"\nwarehouse = "lake"\n', tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append
    ws.session.register("sales", pa.table({"id": [1, 2, 3]}))

    ws.sql("create schema tpch").collect()
    assert changes == [{"name": "tpch", "entry": "\n[schemas.tpch]\n", "kind": "schema"}]

    ws.sql("create table tpch.sales_copy as select * from sales").collect()
    assert changes[-1] == {
        "name": "tpch.sales_copy",
        "entry": '\n[tables.tpch.sales_copy]\npath = "lake/tpch/sales_copy"\nformat = "delta"\n',
        "kind": "table",
    }
    assert (tmp_path / "lake" / "tpch" / "sales_copy").is_dir()
    assert ws.schemas == ["main", "tpch"]
    assert ws.sql("select count(*) as n from tpch.sales_copy").collect().to_pydict()["n"] == [3]


@engine_schemas
def test_create_schema_is_declared_once(tmp_path: Path) -> None:
    _parquet(tmp_path / "data" / "tpch" / "region.parquet", 5)
    ws = parse_config('[tables.tpch.region]\npath = "data/tpch/region.parquet"\n', tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append
    ws.sql("create schema if not exists tpch").collect()
    ws.sql("create schema if not exists tpch").collect()
    assert changes == [{"name": "tpch", "entry": "\n[schemas.tpch]\n", "kind": "schema"}]
    assert ws.declared_schemas == {"tpch": ""}


@engine_schemas
def test_drop_schema_cascade_drops_its_tables(tmp_path: Path) -> None:
    _parquet(tmp_path / "data" / "tpch" / "region.parquet", 5)
    _parquet(tmp_path / "data" / "tpch" / "nation.parquet", 25)
    _parquet(tmp_path / "data" / "orders.parquet", 2)
    text = (
        '[workspace]\nname = "w"\n\n'
        '[tables.tpch.region]\npath = "data/tpch/region.parquet"\n\n'
        '[tables.tpch.nation]\npath = "data/tpch/nation.parquet"\n\n'
        '[tables.orders]\npath = "data/orders.parquet"\n'
    )
    ws = parse_config(text, tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append

    ws.sql("drop schema tpch cascade").collect()
    assert changes == [
        {"name": "tpch.region", "entry": None, "kind": "table"},
        {"name": "tpch.nation", "entry": None, "kind": "table"},
        {"name": "tpch", "entry": None, "kind": "schema"},
    ]
    assert [t.name for t in ws.tables] == ["orders"] and ws.schemas == ["main"]
    assert (tmp_path / "data" / "tpch" / "region.parquet").is_file()  # the files stay
    assert ws.sql("select count(*) as n from orders").collect().to_pydict()["n"] == [2]


@engine_schemas
def test_drop_schema_without_cascade_refuses_tables(tmp_path: Path) -> None:
    _parquet(tmp_path / "data" / "tpch" / "region.parquet", 5)
    ws = parse_config('[tables.tpch.region]\npath = "data/tpch/region.parquet"\n', tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append
    with pytest.raises(ia.IaraError):
        ws.sql("drop schema tpch").collect()
    assert changes == [] and [t.name for t in ws.tables] == ["tpch.region"]


@engine_schemas
def test_dropping_an_empty_declared_schema(tmp_path: Path) -> None:
    ws = parse_config('[schemas.sales]\ndescription = "Sales"\n', tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append
    ws.sql("drop schema sales").collect()
    assert changes == [{"name": "sales", "entry": None, "kind": "schema"}]
    assert ws.declared_schemas == {} and ws.schemas == ["main"]


@engine_schemas
def test_use_sets_the_default_schema_and_emits_nothing(tmp_path: Path) -> None:
    _parquet(tmp_path / "data" / "tpch" / "region.parquet", 5)
    ws = parse_config('[tables.tpch.region]\npath = "data/tpch/region.parquet"\n', tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append

    ws.sql("use tpch").collect()
    assert changes == []
    assert ws.sql("select count(*) as n from region").collect().to_pydict()["n"] == [5]

    ws.sql("use main").collect()
    with pytest.raises(ia.IaraError):
        ws.sql("select count(*) as n from region").collect()
