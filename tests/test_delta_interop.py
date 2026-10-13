"""Delta interoperability: Workhouse against deltalake (delta-rs), polars and duckdb."""

from __future__ import annotations

import datetime as dt
import decimal
import json
import os
import time
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pytest

import workhouse as wh

deltalake = pytest.importorskip("deltalake")
from deltalake import DeltaTable, write_deltalake  # noqa: E402

from compare import diff  # noqa: E402

UTC = dt.timezone.utc


def _p(tmp_path: Path, name: str = "t") -> str:
    return str(tmp_path / name)


def _wh_read(path: str, **kw) -> pa.Table:
    return wh.read_delta(path, **kw).to_arrow()


def _dl_read(path: str, version: int | None = None) -> pa.Table:
    return DeltaTable(path, version=version).to_pyarrow_table()


def _norm_type(t: pa.DataType) -> pa.DataType:
    if pa.types.is_string_view(t) or pa.types.is_large_string(t):
        return pa.string()
    if pa.types.is_binary_view(t) or pa.types.is_large_binary(t):
        return pa.binary()
    if pa.types.is_list(t) or pa.types.is_large_list(t) or pa.types.is_list_view(t):
        return pa.list_(_norm_type(t.value_type))
    if pa.types.is_struct(t):
        return pa.struct([pa.field(f.name, _norm_type(f.type)) for f in t])
    return t


def _norm_table(t: pa.Table) -> pa.Table:
    return t.cast(pa.schema([pa.field(f.name, _norm_type(f.type)) for f in t.schema]))


def _same(a: pa.Table, b: pa.Table, by: str = "id") -> None:
    a, b = _norm_table(a), _norm_table(b)
    a, b = a.select(sorted(a.column_names)).sort_by(by), b.select(sorted(b.column_names)).sort_by(by)
    assert diff(a, b) is None, diff(a, b)


def _basic(n: int = 6, start: int = 0) -> pa.Table:
    ids = list(range(start, start + n))
    return pa.table(
        {
            "id": pa.array(ids, pa.int64()),
            "name": pa.array([f"n{i}" if i % 3 else None for i in ids], pa.string()),
            "v": pa.array([i * 1.5 for i in ids], pa.float64()),
            "grp": pa.array(["a" if i % 2 else "b" for i in ids], pa.string()),
        }
    )


def _wh_write(t: pa.Table, path: str, **kw) -> None:
    wh.from_arrow(t).write_delta(path, **kw)


# --------------------------------------------------------------------- 1. Workhouse writes


def _types_table() -> pa.Table:
    return pa.table(
        {
            "id": pa.array([1, 2, 3], pa.int64()),
            "i8": pa.array([1, None, -3], pa.int8()),
            "i16": pa.array([1, None, -3], pa.int16()),
            "i32": pa.array([1, None, -3], pa.int32()),
            "i64": pa.array([1, None, -3], pa.int64()),
            "f32": pa.array([1.5, None, -3.25], pa.float32()),
            "f64": pa.array([1.5, None, -3.25], pa.float64()),
            "dec": pa.array([decimal.Decimal("1.50"), None, decimal.Decimal("-3.25")], pa.decimal128(10, 2)),
            "s": pa.array(["a", None, "ccc"], pa.string()),
            "b": pa.array([True, None, False], pa.bool_()),
            "d": pa.array([dt.date(2020, 1, 1), None, dt.date(1999, 12, 31)], pa.date32()),
            "ts": pa.array([dt.datetime(2020, 1, 1, 1, 2, 3, 456000, UTC), None, dt.datetime(2021, 5, 5, tzinfo=UTC)], pa.timestamp("us", "UTC")),
            "ts_ntz": pa.array([dt.datetime(2020, 1, 1, 1, 2, 3, 456000), None, dt.datetime(2021, 5, 5)], pa.timestamp("us")),
            "bin": pa.array([b"\x00\x01", None, b"xyz"], pa.binary()),
            "lst": pa.array([[1, 2], None, []], pa.list_(pa.int64())),
            "st": pa.array([{"x": 1, "y": "p"}, None, {"x": None, "y": "q"}], pa.struct([("x", pa.int64()), ("y", pa.string())])),
        }
    )


def test_types_roundtrip_deltalake(tmp_path: Path) -> None:
    path = _p(tmp_path)
    t = _types_table()
    _wh_write(t, path)
    _same(_dl_read(path), t)
    _same(_wh_read(path), t)


def test_unsigned_types_map(tmp_path: Path) -> None:
    path = _p(tmp_path)
    t = pa.table(
        {
            "id": pa.array([1, 2], pa.int64()),
            "u8": pa.array([1, 255], pa.uint8()),
            "u16": pa.array([1, 65535], pa.uint16()),
            "u32": pa.array([1, 4294967295], pa.uint32()),
            "u64": pa.array([1, 2**40], pa.uint64()),
        }
    )
    try:
        _wh_write(t, path)
    except Exception as e:  # a clear refusal is acceptable; record it
        pytest.skip(f"unsigned types refused: {e}")
    got = _dl_read(path)
    assert got.column("u8").to_pylist() == [1, 255]
    assert got.column("u16").to_pylist() == [1, 65535]
    assert got.column("u32").to_pylist() == [1, 4294967295]
    assert got.column("u64").to_pylist() == [1, 2**40], str(got.schema)


def test_types_delta_schema_names(tmp_path: Path) -> None:
    path = _p(tmp_path)
    _wh_write(_types_table(), path)
    meta = json.loads(DeltaTable(path).schema().to_json())
    prim = {f["name"]: f["type"] for f in meta["fields"]}
    assert prim["i8"] == "byte" and prim["i16"] == "short" and prim["i32"] == "integer" and prim["i64"] == "long"
    assert prim["f32"] == "float" and prim["f64"] == "double"
    assert prim["s"] == "string" and prim["b"] == "boolean" and prim["d"] == "date"
    assert prim["ts"] == "timestamp" and prim["ts_ntz"] == "timestamp_ntz" and prim["bin"] == "binary"
    assert prim["dec"] == "decimal(10,2)"


def test_types_polars(tmp_path: Path) -> None:
    pl = pytest.importorskip("polars")
    path = _p(tmp_path)
    t = _types_table()
    _wh_write(t, path)
    _same(pl.read_delta(path).to_arrow(), t)
    _same(pl.scan_delta(path).collect().to_arrow(), t)


@pytest.fixture(scope="module")
def duck():
    duckdb = pytest.importorskip("duckdb")
    con = duckdb.connect()
    try:
        con.execute("INSTALL delta")
        con.execute("LOAD delta")
    except Exception as e:
        pytest.skip(f"duckdb delta extension unavailable offline: {e}")
    return con


def test_duckdb_reads_workhouse(tmp_path: Path, duck) -> None:
    path = _p(tmp_path)
    t = _basic(20)
    _wh_write(t.slice(0, 10), path)
    _wh_write(t.slice(10), path, mode="append")
    got = duck.execute(f"select * from delta_scan('{Path(path).as_posix()}')").fetch_arrow_table()
    _same(got, t)


def test_duckdb_partitioned(tmp_path: Path, duck) -> None:
    path = _p(tmp_path)
    t = _basic(12)
    _wh_write(t, path, partition_by="grp")
    got = duck.execute(f"select * from delta_scan('{Path(path).as_posix()}')").fetch_arrow_table()
    _same(got, t)


@pytest.mark.parametrize("part", ["grp", "d"])
def test_partitioned_write(tmp_path: Path, part: str) -> None:
    path = _p(tmp_path)
    t = _basic(12).append_column("d", pa.array([dt.date(2024, 1, 1 + i % 3) for i in range(12)], pa.date32()))
    _wh_write(t, path, partition_by=part)
    dtb = DeltaTable(path)
    assert dtb.metadata().partition_columns == [part]
    _same(dtb.to_pyarrow_table(), t)
    first = t.column(part)[0].as_py()
    sub = dtb.to_pyarrow_table(filters=[(part, "=", first)])
    _same(sub, t.filter(pc.equal(t.column(part), pa.scalar(first))))
    adds = pa.table(dtb.get_add_actions(flatten=True)).to_pylist()
    assert all(f"partition.{part}" in a for a in adds)
    _same(_wh_read(path), t)


def test_appends_overwrite_history_versions(tmp_path: Path) -> None:
    path = _p(tmp_path)
    a, b, c = _basic(5, 0), _basic(5, 100), _basic(3, 500)
    _wh_write(a, path)
    _wh_write(b, path, mode="append")
    _wh_write(c, path, mode="overwrite")
    dtb = DeltaTable(path)
    assert dtb.version() == 2
    hist = dtb.history()
    assert len(hist) == 3
    ab = pa.concat_tables([a, b])
    _same(_dl_read(path, 0), a)
    _same(_dl_read(path, 1), ab)
    _same(_dl_read(path, 2), c)
    for v, exp in [(0, a), (1, ab), (2, c)]:
        _same(_wh_read(path, version=v), exp)
    assert "overwrite" in json.dumps(hist, default=str).lower()


def test_timestamp_time_travel_matches(tmp_path: Path) -> None:
    path = _p(tmp_path)
    _wh_write(_basic(3, 0), path)
    time.sleep(1.2)
    _wh_write(_basic(3, 10), path, mode="append")
    hist = DeltaTable(path).history()
    ts_of = {h["version"]: h["timestamp"] for h in hist}
    ts = dt.datetime.fromtimestamp(ts_of[0] / 1000 + 0.3, UTC)
    got = _wh_read(path, timestamp=ts)
    other = DeltaTable(path)
    other.load_as_version(ts)
    assert other.version() == 0
    _same(got, other.to_pyarrow_table())
    assert got.num_rows == 3


def test_schema_evolution_wh_write_dl_read(tmp_path: Path) -> None:
    path = _p(tmp_path)
    _wh_write(_basic(4, 0), path)
    b = _basic(4, 10).append_column("extra", pa.array([1, 2, 3, 4], pa.int64()))
    _wh_write(b, path, mode="append", schema_mode="merge")
    got = _dl_read(path)
    assert "extra" in got.column_names
    assert got.num_rows == 8
    assert sorted(got.column("extra").to_pylist(), key=lambda x: (x is None, x)) == [1, 2, 3, 4, None, None, None, None]


# --------------------------------------------------------------------- 4. stats


def test_stats_parse_in_deltalake(tmp_path: Path) -> None:
    path = _p(tmp_path)
    t = _basic(10)
    _wh_write(t, path)
    adds = pa.table(DeltaTable(path).get_add_actions(flatten=True)).to_pylist()
    assert len(adds) == 1
    a = adds[0]
    assert a["num_records"] == 10
    assert a["min.id"] == 0 and a["max.id"] == 9
    assert a["min.v"] == 0.0 and a["max.v"] == 13.5
    assert a["null_count.name"] == sum(1 for x in t.column("name").to_pylist() if x is None)
    assert a["min.name"] == "n1" and a["max.name"] == "n8"
    assert a["null_count.id"] == 0


def test_stats_skipping_in_deltalake(tmp_path: Path) -> None:
    path = _p(tmp_path)
    for i in range(3):
        _wh_write(_basic(5, i * 100), path, mode="append" if i else "error")
    dtb = DeltaTable(path)
    assert dtb.to_pyarrow_table(filters=[("id", ">=", 200)]).num_rows == 5
    adds = pa.table(dtb.get_add_actions(flatten=True)).to_pylist()
    assert sorted(a["min.id"] for a in adds) == [0, 100, 200]


# --------------------------------------------------------------------- 2. deltalake writes, Workhouse reads


def test_dl_append_overwrite(tmp_path: Path) -> None:
    path = _p(tmp_path)
    a, b, c = _basic(5, 0), _basic(5, 50), _basic(4, 90)
    write_deltalake(path, a)
    write_deltalake(path, b, mode="append")
    _same(_wh_read(path), pa.concat_tables([a, b]))
    write_deltalake(path, c, mode="overwrite")
    _same(_wh_read(path), c)
    for v in range(3):
        _same(_wh_read(path, version=v), _dl_read(path, v))


def test_dl_types(tmp_path: Path) -> None:
    path = _p(tmp_path)
    t = _types_table()
    write_deltalake(path, t)
    _same(_wh_read(path), t)


def test_dl_partitioned(tmp_path: Path) -> None:
    path = _p(tmp_path)
    t = _basic(12).append_column("d", pa.array([dt.date(2024, 1, 1 + i % 3) for i in range(12)], pa.date32()))
    write_deltalake(path, t, partition_by=["grp", "d"])
    _same(_wh_read(path), t)
    got = wh.scan_delta(path).filter(wh.col("grp") == "a").collect().to_arrow()
    _same(got, t.filter(pc.equal(t.column("grp"), "a")))


def test_dl_schema_evolution(tmp_path: Path) -> None:
    path = _p(tmp_path)
    a = _basic(3, 0)
    write_deltalake(path, a)
    b = _basic(3, 10).append_column("extra", pa.array([7, 8, 9], pa.int64()))
    write_deltalake(path, b, mode="append", schema_mode="merge")
    got = _wh_read(path)
    assert "extra" in got.column_names
    _same(got, _dl_read(path))
    old = _wh_read(path, version=0)
    assert "extra" not in old.column_names
    _same(old, a)


def test_dl_delete_update(tmp_path: Path) -> None:
    path = _p(tmp_path)
    write_deltalake(path, _basic(10))
    dtb = DeltaTable(path)
    dtb.delete("id < 3")
    dtb.update({"v": "100.0"}, predicate="id = 5")
    _same(_wh_read(path), _dl_read(path))
    for v in range(dtb.version() + 1):
        _same(_wh_read(path, version=v), _dl_read(path, v))


def test_dl_deletion_vectors_refused(tmp_path: Path) -> None:
    path = _p(tmp_path)
    write_deltalake(path, _basic(10), configuration={"delta.enableDeletionVectors": "true"})
    DeltaTable(path).delete("id = 4")
    log = Path(path) / "_delta_log"
    raw = "".join((log / f).read_text() for f in sorted(os.listdir(log)) if f.endswith(".json"))
    if "deletionVector" not in raw:
        pytest.skip("deltalake did not produce deletion vectors for this delete")
    with pytest.raises(Exception, match=r"(?i)deletion"):
        _wh_read(path)


def test_dl_checkpoint_then_commits(tmp_path: Path) -> None:
    path = _p(tmp_path)
    write_deltalake(path, _basic(3, 0))
    for i in range(1, 5):
        write_deltalake(path, _basic(3, i * 10), mode="append")
    DeltaTable(path).create_checkpoint()
    for i in range(5, 8):
        write_deltalake(path, _basic(3, i * 10), mode="append")
    assert any(f.endswith(".checkpoint.parquet") for f in os.listdir(Path(path) / "_delta_log"))
    _same(_wh_read(path), _dl_read(path))
    assert _wh_read(path).num_rows == 24
    _same(_wh_read(path, version=4), _dl_read(path, 4))
    _same(_wh_read(path, version=6), _dl_read(path, 6))


def test_dl_compact_vacuum(tmp_path: Path) -> None:
    path = _p(tmp_path)
    for i in range(5):
        write_deltalake(path, _basic(4, i * 10), mode="append")
    dtb = DeltaTable(path)
    dtb.optimize.compact()
    dtb.vacuum(retention_hours=0, enforce_retention_duration=False, dry_run=False)
    _same(_wh_read(path), DeltaTable(path).to_pyarrow_table())
    assert _wh_read(path).num_rows == 20


def test_dl_timestamp_time_travel(tmp_path: Path) -> None:
    path = _p(tmp_path)
    write_deltalake(path, _basic(3, 0))
    time.sleep(1.2)
    write_deltalake(path, _basic(3, 10), mode="append")
    ts_of = {h["version"]: h["timestamp"] for h in DeltaTable(path).history()}
    ts = dt.datetime.fromtimestamp(ts_of[0] / 1000 + 0.3, UTC)
    got = _wh_read(path, timestamp=ts)
    other = DeltaTable(path)
    other.load_as_version(ts)
    _same(got, other.to_pyarrow_table())
    assert got.num_rows == 3


# --------------------------------------------------------------------- 3. mixed writers


def test_mixed_writers(tmp_path: Path) -> None:
    path = _p(tmp_path)
    a, b, c, d = _basic(3, 0), _basic(3, 10), _basic(3, 20), _basic(3, 30)
    write_deltalake(path, a)
    _wh_write(b, path, mode="append")
    write_deltalake(path, c, mode="append")
    _wh_write(d, path, mode="append")
    dtb = DeltaTable(path)
    assert dtb.version() == 3
    assert sorted(f for f in os.listdir(Path(path) / "_delta_log") if f.endswith(".json"))[:4] == [f"{i:020d}.json" for i in range(4)]
    _same(dtb.to_pyarrow_table(), pa.concat_tables([a, b, c, d]))
    _same(_wh_read(path), pa.concat_tables([a, b, c, d]))
    for v, parts in enumerate([[a], [a, b], [a, b, c], [a, b, c, d]]):
        _same(_wh_read(path, version=v), pa.concat_tables(parts))
        _same(_dl_read(path, v), pa.concat_tables(parts))


def test_wh_created_dl_appends(tmp_path: Path) -> None:
    path = _p(tmp_path)
    a = _types_table()
    b = a.set_column(0, "id", pa.array([10, 20, 30], pa.int64()))
    _wh_write(a, path)
    write_deltalake(path, b, mode="append")
    _same(_wh_read(path), pa.concat_tables([a, b]))
    _same(_dl_read(path), pa.concat_tables([a, b]))


# --------------------------------------------------------------------- 5. checkpoint written by Workhouse


def test_wh_checkpoint_readable_by_deltalake(tmp_path: Path) -> None:
    path = _p(tmp_path)
    parts = [_basic(2, i * 10) for i in range(12)]
    _wh_write(parts[0], path)
    for p in parts[1:]:
        _wh_write(p, path, mode="append")
    log = Path(path) / "_delta_log"
    cps = [f for f in os.listdir(log) if "checkpoint" in f]
    if not cps:
        pytest.skip("Workhouse wrote no checkpoint after 12 commits (no auto checkpoint)")
    exp = pa.concat_tables(parts)
    _same(_dl_read(path), exp)
    assert (log / "_last_checkpoint").exists()
    cp_version = int(sorted(cps)[0].split(".")[0])
    for f in os.listdir(log):
        if f.endswith(".json") and int(f.split(".")[0]) <= cp_version:
            (log / f).unlink()
    dtb = DeltaTable(path)
    assert dtb.version() == 11
    _same(dtb.to_pyarrow_table(), exp)
    _same(_wh_read(path), exp)
