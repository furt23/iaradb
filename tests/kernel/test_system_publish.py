"""``system.publish``: a JSON-lines file as one typed Parquet file."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import iara as ia
from iara.kernel.system import publish

COLUMNS = [["id", "int"], ["name", "string"], ["score", "float"], ["ok", "bool"], ["at", "timestamp"]]


def write_lines(path: Path, rows: list[dict[str, Any]]) -> Path:
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    return path


def test_types_nulls_and_extra_fields(tmp_path: Path):
    source = write_lines(
        tmp_path / "in.jsonl",
        [
            {"id": 1, "name": "a", "score": 1.5, "ok": True, "at": 1700000000000, "extra": "dropped"},
            {"id": 2, "name": "b"},
        ],
    )
    dest = tmp_path / "out.parquet"
    assert publish({"source": str(source), "dest": str(dest), "columns": COLUMNS}) == {"rows": 2, "bytes": dest.stat().st_size}
    table = pq.read_table(dest)
    assert table.column_names == ["id", "name", "score", "ok", "at"]
    assert table.schema.field("id").type == pa.int64() and table.schema.field("score").type == pa.float64()
    assert table.schema.field("ok").type == pa.bool_() and table.schema.field("name").type == pa.string()
    assert table.column("score").to_pylist() == [1.5, None]
    assert table.column("ok").to_pylist() == [True, None]


def test_timestamps_are_unix_milliseconds(tmp_path: Path):
    source = write_lines(tmp_path / "in.jsonl", [{"id": 1, "at": 1700000000000}, {"id": 2, "at": None}])
    dest = tmp_path / "out.parquet"
    publish({"source": str(source), "dest": str(dest), "columns": [["id", "int"], ["at", "timestamp"]]})
    table = pq.read_table(dest)
    assert table.schema.field("at").type == pa.timestamp("ms")
    assert table.column("at").to_pylist() == [dt.datetime(2023, 11, 14, 22, 13, 20), None]


def test_a_missing_source_gives_an_empty_table_with_the_schema(tmp_path: Path):
    dest = tmp_path / "out.parquet"
    assert publish({"source": str(tmp_path / "none.jsonl"), "dest": str(dest), "columns": COLUMNS}) == {"rows": 0, "bytes": dest.stat().st_size}
    schema = pq.read_schema(dest)
    assert schema.names == ["id", "name", "score", "ok", "at"] and schema.field("at").type == pa.timestamp("ms")


def test_an_empty_source_gives_an_empty_table(tmp_path: Path):
    source = tmp_path / "empty.jsonl"
    source.write_text("")
    dest = tmp_path / "out.parquet"
    assert publish({"source": str(source), "dest": str(dest), "columns": COLUMNS})["rows"] == 0
    assert pq.read_table(dest).num_rows == 0


def test_an_unknown_column_type_is_refused(tmp_path: Path):
    with pytest.raises(ValueError, match="unknown column type"):
        publish({"source": str(tmp_path / "x.jsonl"), "dest": str(tmp_path / "out.parquet"), "columns": [["a", "decimal"]]})


def test_the_result_reads_back_with_scan_parquet(tmp_path: Path):
    source = write_lines(tmp_path / "in.jsonl", [{"id": i, "name": f"n{i}"} for i in range(5)])
    dest = tmp_path / "out.parquet"
    publish({"source": str(source), "dest": str(dest), "columns": [["id", "int"], ["name", "string"]]})
    assert ia.scan_parquet(str(dest)).collect().height == 5
