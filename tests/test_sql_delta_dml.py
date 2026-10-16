"""DELETE / UPDATE / MERGE and the Delta maintenance statements through a workspace."""

from __future__ import annotations

from pathlib import Path

import pyarrow as pa
import pytest

from iara.sqlwrite import is_write
from iara.workspaces import parse_config

CONFIG = '[workspace]\nname = "w"\nwarehouse = "lake"\n'


def _ws(tmp_path: Path):
    ws = parse_config(CONFIG, tmp_path)
    changes: list[dict] = []
    ws.on_catalog_change = changes.append
    ws.session.register("src", pa.table({"id": list(range(10)), "v": [i * 10 for i in range(10)]}))
    ws.sql("create table t as select * from src").collect()
    return ws, changes


def _n(ws, query: str, params=None) -> int:
    return ws.sql(query, params).collect().item()


def test_classification() -> None:
    assert is_write("comment on table t is 'x'")
    assert not is_write("describe history t")
    assert not is_write("describe detail t")


def test_dml_with_params(tmp_path: Path) -> None:
    ws, _ = _ws(tmp_path)
    done = ws.sql("delete from t where id >= :lo", {"lo": 8}).collect().to_arrow().to_pylist()[0]
    assert done["operation"] == "delete" and done["num_affected_rows"] == 2 and done["version"] == 1
    ws.sql("update t set v = v + $1 where id = $2", [5, 1]).collect()
    assert _n(ws, "select v from t where id = 1") == 15
    ws.sql(
        "merge into t using (select 3 as id, 0 as v union all select 50 as id, 1 as v) s on t.id = s.id "
        "when matched then update set v = s.v when not matched then insert *"
    ).collect()
    assert _n(ws, "select count(*) from t") == 9
    assert _n(ws, "select v from t where id = 50") == 1


def test_maintenance_reads_and_writes(tmp_path: Path) -> None:
    ws, changes = _ws(tmp_path)
    ws.sql("insert into t select id + 100, v from src").collect()
    ws.sql("update t set v = 0 where id = 1").collect()
    history = ws.sql("describe history t").collect().to_arrow()
    assert history.column("operation").to_pylist()[0] == "UPDATE"
    assert ws.sql("describe detail t").collect().to_arrow().column("format").to_pylist() == ["delta"]
    ws.sql("optimize t").collect()
    vac = ws.sql("vacuum t dry run").collect().to_arrow().to_pylist()[0]
    assert vac["dry_run"] == 1
    with pytest.raises(Exception, match="(?i)retention"):
        ws.sql("vacuum t retain 0 hours").collect()
    ws.sql("restore table t to version as of 0").collect()
    assert _n(ws, "select count(*) from t") == 10

    changes.clear()
    ws.sql("alter table t add column note text").collect()
    assert changes and changes[-1]["kind"] == "refresh"
    assert "note" in ws.sql("select * from t").collect().to_arrow().column_names
    ws.sql("alter table t set tblproperties ('team' = 'data')").collect()
    props = ws.sql("describe detail t").collect().to_arrow().column("properties").to_pylist()[0]
    assert dict(props) == {"team": "data"}


def test_view_sees_later_writes_and_parquet_is_refused(tmp_path: Path) -> None:
    ws, _ = _ws(tmp_path)
    ws.sql("create view big as select * from t where id >= 5").collect()
    assert _n(ws, "select count(*) from big") == 5
    ws.sql("insert into t select id + 100, v from src").collect()
    assert _n(ws, "select count(*) from big") == 15
    path = (tmp_path / "p.parquet").as_posix()
    ws.sql(f"copy (select * from src) to '{path}' (format parquet)").collect()
    ws.session.register_parquet("pq", path)
    with pytest.raises(Exception, match="Delta table"):
        ws.sql("delete from pq").collect()
