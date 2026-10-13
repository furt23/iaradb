"""Delta as the default table format of a workspace: statements, catalog changes,
discovery and the table details the kernel reports."""

from __future__ import annotations

from pathlib import Path

import pyarrow as pa
import pytest

import workhouse as wh
from workhouse.kernel import catalog
from workhouse.sqlwrite import WriteResult, is_schema_statement, is_write
from workhouse.storage import delta_info
from workhouse.workspaces import parse_config

CONFIG = '[workspace]\nname = "w"\nwarehouse = "lake"\n'


def _ws(tmp_path: Path):
    ws = parse_config(CONFIG, tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append
    ws.session.register("src", pa.table({"id": list(range(10)), "year": [2020 + i % 2 for i in range(10)]}))
    return ws, changes


def _n(ws, query: str) -> int:
    return ws.sql(query).collect().item()


def test_new_statements_are_writes() -> None:
    for q in [
        "create view v as select 1",
        "drop view v",
        "truncate table t",
        "insert overwrite t select 1",
        "update t set a = 1",
        "delete from t",
        "merge into t using s on true",
        "optimize t",
        "vacuum t",
        "restore table t to version as of 1",
        "alter table t add column c int",
        "  -- note\n truncate t",
    ]:
        assert is_write(q), q
    for q in ["show tables", "describe t", "select 1", "with x as (select 1) select * from x"]:
        assert not is_write(q), q
    assert is_schema_statement("create or replace temp view v as select 1") and is_schema_statement("drop view v")
    assert not is_schema_statement("create table v as select 1")


def test_created_tables_are_delta_in_the_catalog(tmp_path: Path) -> None:
    ws, changes = _ws(tmp_path)
    ws.sql("create table t as select * from src").collect()
    assert (tmp_path / "lake" / "t" / "_delta_log").is_dir()
    assert changes == [{"name": "t", "entry": '\n[tables.t]\npath = "lake/t"\nformat = "delta"\n', "kind": "table"}]
    assert ws.spec("t").format == "delta"

    done = WriteResult.of(ws.sql("insert into t select id + 100, year from src").collect())
    assert (done.operation, done.rows, done.format, done.version) == ("insert", 10, "delta", 1)
    assert _n(ws, "select count(*) from t") == 20
    assert _n(ws, "select count(*) from t version as of 0") == 10
    ws.sql("insert overwrite t select * from src where id < 3").collect()
    assert _n(ws, "select count(*) from t") == 3
    ws.sql("truncate table t").collect()
    assert _n(ws, "select count(*) from t") == 0

    # a workspace reloaded from the entry reads the same table
    fresh = parse_config('[workspace]\nname = "w"\n' + changes[0]["entry"], tmp_path)
    assert _n(fresh, "select count(*) from t version as of 0") == 10

    # DROP deletes a managed table's folder
    ws.sql("drop table t").collect()
    assert changes[-1] == {"name": "t", "entry": None, "kind": "table"}
    assert not (tmp_path / "lake" / "t").exists()


def test_forked_sessions_publish_delta_writes(tmp_path: Path) -> None:
    ws, changes = _ws(tmp_path)
    extra = wh.from_dict({"id": [1000], "year": [2030]})
    ws.sql("create table t as select * from src").collect()
    ws.sql("insert into t select * from extra", extra=extra).collect()
    assert _n(ws, "select count(*) from t where year = 2030") == 1
    ws.sql("create table u as select * from extra", extra=extra).collect()
    assert _n(ws, "select count(*) from u") == 1
    assert [c["name"] for c in changes] == ["t", "u"]


def test_legacy_parquet_folders_stay_parquet(tmp_path: Path) -> None:
    ws, changes = _ws(tmp_path)
    ws.sql("create table old using parquet as select * from src").collect()
    assert not (tmp_path / "lake" / "old" / "_delta_log").exists()
    assert changes[-1]["entry"] == '\n[tables.old]\npath = "lake/old"\n'
    ws.sql("insert into old select id + 100, year from src").collect()
    assert _n(ws, "select count(*) from old") == 20
    ws.sql("drop table old").collect()
    assert (tmp_path / "lake" / "old").is_dir(), "plain Parquet files are not deleted"


def test_registration_detects_delta_once(tmp_path: Path) -> None:
    ws, _ = _ws(tmp_path)
    ws.sql("create table t as select * from src").collect()
    # an entry without a format that points at a Delta folder is read as Delta
    plain = parse_config('[tables.t2]\npath = "lake/t"\n', tmp_path)
    assert plain.spec("t2").format == "parquet"
    assert _n(plain, "select count(*) from t2") == 10
    ws.sql("insert into t select * from src").collect()
    again = parse_config('[tables.t2]\npath = "lake/t"\n', tmp_path)
    assert _n(again, "select count(*) from t2") == 20, "removed files are not read"


def test_schema_locations_discover_delta_tables(tmp_path: Path) -> None:
    ws = parse_config('[schemas.s]\nlocation = "loc"\n', tmp_path)
    ws.session.register("src", pa.table({"id": [1, 2]}))
    ws.sql("create table s.a as select * from src").collect()
    ws.sql("create table s.empty (id bigint not null)").collect()
    found = {t.name: t.format for t in ws.discovered}
    assert found == {"s.a": "delta", "s.empty": "delta"}
    fresh = parse_config('[schemas.s]\nlocation = "loc"\n', tmp_path)
    fresh.session
    assert {t.name: t.format for t in fresh.discovered} == found
    assert _n(fresh, "select count(*) from s.a") == 2
    assert _n(fresh, "select count(*) from s.empty") == 0


def test_show_describe_and_views(tmp_path: Path) -> None:
    ws, changes = _ws(tmp_path)
    ws.sql("create table t (id bigint not null, name text) partitioned by (name)").collect()
    tables = ws.sql("show tables").collect().to_pydict()
    assert tables["table"] == ["t", "src"] or set(tables["table"]) == {"t", "src"}
    cols = ws.sql("describe t").collect().to_pydict()
    assert cols["column_name"] == ["id", "name"] and cols["nullable"] == [False, True] and cols["is_partition"] == [False, True]
    assert ws.sql("show schemas").collect().to_pydict()["schema"] == ["main"]
    n = len(changes)
    ws.sql("create view v as select id from t").collect()
    assert len(changes) == n, "views are not persisted yet"
    assert WriteResult.of(ws.sql("create or replace view v as select id from t").collect()).format == "view"
    assert _n(ws, "select count(*) from v") == 0
    ws.sql("drop view v").collect()
    with pytest.raises(wh.WorkhouseError):
        ws.sql("select * from v").collect()


def test_not_null_is_enforced(tmp_path: Path) -> None:
    ws, _ = _ws(tmp_path)
    ws.sql("create table t (id bigint not null, note text)").collect()
    with pytest.raises(wh.WorkhouseError, match="NOT NULL"):
        ws.sql("insert into t select null, 'x'").collect()
    ws.sql("insert into t (id) select 1").collect()
    assert _n(ws, "select count(*) from t") == 1


def test_table_details_come_from_the_log(tmp_path: Path) -> None:
    ws, _ = _ws(tmp_path)
    ws.sql("create table t partitioned by (year) as select * from src").collect()
    ws.sql("insert overwrite t select * from src where id < 5").collect()
    info = catalog.table_info(ws, "t")
    assert info["format"] == "delta" and info["version"] == 1
    assert info["files"] == 2 and info["partitions"] == ["year"]
    assert info["num_rows"] == 5 and info["bytes"] > 0
    raw = delta_info(str(tmp_path / "lake" / "t"))
    assert raw["version"] == 1 and raw["num_files"] == 2 and raw["partition_columns"] == ["year"]
