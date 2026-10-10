"""Partitioned datasets and SQL that writes: interoperable with DuckDB, and
kept in a workspace's catalog."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import duckdb
import pyarrow as pa
import pytest

import workhouse as wh
from workhouse.workspaces import parse_config

sys.path.insert(0, os.path.dirname(__file__))
from compare import diff  # noqa: E402

N = 5000


@pytest.fixture()
def sales() -> pa.Table:
    return pa.table(
        {
            "id": list(range(N)),
            "year": [2020 + i % 3 for i in range(N)],
            "region": [None if i % 13 == 0 else ["north", "south", "a b/c"][i % 3] for i in range(N)],
            "amount": [float(i % 97) for i in range(N)],
        }
    )


CHECK = "select year, region, count(*) as n, sum(amount) as total from t group by all order by 1, 2"


def test_duckdb_reads_what_we_partition(sales: pa.Table, tmp_path: Path) -> None:
    out = tmp_path / "sales"
    assert wh.from_arrow(sales).lazy().sink_parquet(out, partition_by=["year", "region"]) == N
    assert (out / "year=2021").is_dir()
    con = duckdb.connect()
    con.register("src", sales)
    path = (out / "**" / "*.parquet").as_posix()
    theirs = con.execute(f"{CHECK.replace(' t ', f' read_parquet(\'{path}\', hive_partitioning=true) ')}").arrow().read_all()
    ours = con.execute(CHECK.replace(" t ", " src ")).arrow().read_all()
    # DuckDB reads the partition values back as written (years as numbers)
    assert diff(theirs, ours, ordered=True) is None


def test_we_read_what_duckdb_partitions(sales: pa.Table, tmp_path: Path) -> None:
    con = duckdb.connect()
    con.register("src", sales)
    out = (tmp_path / "duck").as_posix()
    con.execute(f"copy (select * from src) to '{out}' (format parquet, partition_by (year, region))")
    ctx = wh.SessionContext()
    ctx.register_parquet("t", out)
    expected = con.execute(CHECK.replace(" t ", " src ")).arrow().read_all()
    assert diff(ctx.sql(CHECK).collect().to_arrow(), expected, ordered=True) is None
    # filters on partition columns skip whole files
    assert "partitions=1/" in ctx.sql("select count(*) from t where year = 2021 and region = 'south'").explain()


def test_workspace_tables_created_by_sql_join_the_catalog(sales: pa.Table, tmp_path: Path) -> None:
    ws = parse_config('[workspace]\nname = "w"\nwarehouse = "lake"\n', tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append
    ws.session.register("sales", sales)

    done = ws.sql("create table by_year partitioned by (year) as select id, year, amount from sales").collect()
    assert done.to_pydict()["rows"] == [N]
    assert (tmp_path / "lake" / "by_year" / "year=2022").is_dir()
    assert changes == [{"name": "by_year", "entry": '\n[tables.by_year]\npath = "lake/by_year"\n', "kind": "table"}]
    assert [t.name for t in ws.tables] == ["by_year"]

    # a frame from a notebook cell feeds an INSERT; the main session sees the new rows
    extra = wh.from_dict({"id": [-1], "amount": [1.0], "year": [2030]})
    ws.sql("insert into by_year select * from extra", extra=extra)
    assert ws.sql("select count(*) as n from by_year where year = 2030").collect().to_pydict()["n"] == [1]

    # a workspace reloaded from the new entry finds the table (partitions included)
    fresh = parse_config('[workspace]\nname = "w"\n' + changes[0]["entry"], tmp_path)
    assert fresh.sql("select count(*) as n from by_year").collect().to_pydict()["n"] == [N + 1]

    ws.sql("drop table by_year")
    assert changes[-1] == {"name": "by_year", "entry": None, "kind": "table"}
    assert ws.tables == []
    with pytest.raises(wh.WorkhouseError):
        ws.sql("select * from by_year").collect()


def test_statements_explain_their_mistakes(tmp_path: Path) -> None:
    ctx = wh.SessionContext()
    with pytest.raises(wh.WorkhouseError, match="COPY needs a query"):
        ctx.sql("copy t to 'x'")
    with pytest.raises(wh.WorkhouseError, match="unknown COPY option"):
        ctx.sql(f"copy (select 1 as x) to '{(tmp_path / 'x.parquet').as_posix()}' (colour blue)")
    with pytest.raises(wh.WorkhouseError, match="PARTITIONED BY needs a warehouse"):
        ctx.sql("create table t partitioned by (x) as select 1 as x, 2 as y")
