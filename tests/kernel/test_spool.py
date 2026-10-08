"""Large results spooled to disk: paging, sorting and exports read the mapped file."""

from __future__ import annotations

from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pytest

import workhouse as wh
from workhouse.kernel.runtime.results import ResultStore
from workhouse.kernel.runtime.spool import Spool, parse_size

N = 200_000


@pytest.fixture(scope="module")
def lf() -> wh.LazyFrame:
    t = pa.table(
        {
            "id": pa.array(range(N), pa.int64()),
            "g": [i % 13 for i in range(N)],
            "s": [None if i % 17 == 0 else f"v{(i * 7) % 1000:04d}" for i in range(N)],
        }
    )
    return wh.from_arrow(t).lazy()


def test_parse_size() -> None:
    assert parse_size("1024") == 1024
    assert parse_size("512MB") == 512 << 20
    assert parse_size("1.5gb") == 3 << 29
    with pytest.raises(ValueError):
        parse_size("lots")


def test_small_results_stay_in_memory(lf: wh.LazyFrame, tmp_path: Path) -> None:
    spooled = Spool(threshold=1 << 30, root=str(tmp_path)).collect(lf.stream())
    assert spooled.path is None
    assert spooled.table.equals(lf.collect().to_arrow())
    assert {"elapsed_ms", "memory_peak", "spilled_bytes", "pipelines"} <= spooled.profile.keys()


def test_large_results_go_to_disk(lf: wh.LazyFrame, tmp_path: Path) -> None:
    spool = Spool(threshold=64 << 10, root=str(tmp_path))
    spooled = spool.collect(lf.filter(wh.col("g") < 10).stream())
    assert spooled.path is not None and spooled.path.is_file() and tmp_path in spooled.path.parents
    expected = lf.filter(wh.col("g") < 10).collect().to_arrow()
    assert spooled.table.equals(expected)
    # the DataFrame of the cell's output variable reads the mapped file
    assert wh.from_arrow(spooled.table).height == expected.num_rows
    del spooled
    spool.close()
    assert not any(tmp_path.iterdir())


def test_store_pages_and_sorts_spooled_results(lf: wh.LazyFrame, tmp_path: Path) -> None:
    store = ResultStore(spool=Spool(threshold=64 << 10, root=str(tmp_path)))
    spooled = store.spool.collect(lf.stream())
    out = store.put(spooled.table, "big", spooled.path)
    assert out["on_disk"] and out["num_rows"] == N
    rid = out["id"]
    assert store.page(rid, 1000, 3)["rows"] == [[1000, 1000 % 13, f"v{7000 % 1000:04d}"], [1001, 1001 % 13, f"v{7007 % 1000:04d}"], [1002, 1002 % 13, f"v{7014 % 1000:04d}"]]
    # sorted by the engine (out of core), like pyarrow: nulls last, ties in order
    table = spooled.table
    for sort in ([{"column": "g", "descending": True}], [{"column": "s"}, {"column": "id", "descending": True}]):
        keys = [(s["column"], "descending" if s.get("descending") else "ascending") for s in sort]
        want = table.take(pc.sort_indices(table, sort_keys=keys))
        got = store.page(rid, 0, 10_000, sort)
        assert got["rows"] == [list(r.values()) for r in want.slice(0, 10_000).to_pylist()], sort
        tail = store.page(rid, N - 50, 50, sort)
        assert tail["rows"] == [list(r.values()) for r in want.slice(N - 50).to_pylist()], sort


def test_export_of_a_spooled_result(lf: wh.LazyFrame, tmp_path: Path) -> None:
    store = ResultStore(spool=Spool(threshold=64 << 10, root=str(tmp_path / "spool")))
    spooled = store.spool.collect(lf.stream())
    rid = store.put(spooled.table, "big", spooled.path)["id"]
    path = store.export(rid, str(tmp_path / "all.parquet"), "parquet")
    import pyarrow.parquet as pq

    assert pq.read_table(path).num_rows == N
