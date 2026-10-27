"""Result pages as Arrow IPC streams: a browser decodes the values the JSON pages carry."""

from __future__ import annotations

import base64
import datetime as dt
import decimal
import json
import math
import os
from pathlib import Path
from typing import Any

import pyarrow as pa
import pytest

from iara.kernel.runtime.arrow_page import display_table, ipc_page
from iara.kernel.runtime.results import ResultStore, json_value
from iara.kernel.runtime.spool import Spool
from iara.kernel.session import KernelSession


def decode(page: dict[str, Any]) -> pa.Table:
    return pa.ipc.open_stream(base64.b64decode(page["data"])).read_all()


def mixed_table() -> pa.Table:
    """A column of each kind the display rules cover, with nulls in each."""
    return pa.table(
        {
            "i32": pa.array([1, None, -3], pa.int32()),
            "f64": pa.array([1.5, math.nan, None], pa.float64()),
            "flag": pa.array([True, None, False]),
            "s": pa.array(["a", None, "é"], pa.string()),
            "ls": pa.array(["x", None, "yy"], pa.large_string()),
            "sv": pa.array(["p", None, "q"], pa.string_view()),
            "dict": pa.array(["k", None, "k"]).dictionary_encode(),
            "small": pa.array([5, None, 2**53 - 1], pa.int64()),
            "big": pa.array([2**60, None, -(2**60)], pa.int64()),
            "dec": pa.array([decimal.Decimal("1.50"), None, decimal.Decimal("-2.25")], pa.decimal128(10, 2)),
            "day": pa.array([dt.date(2024, 1, 2), None, dt.date(1999, 12, 31)], pa.date32()),
            "ts": pa.array([dt.datetime(2024, 1, 2, 3, 4, 5), None, dt.datetime(2020, 2, 29)], pa.timestamp("us")),
            "bin": pa.array([b"x" * 100, None, b"ab"], pa.binary()),
            "lst": pa.array([[1, 2], None, []], pa.list_(pa.int64())),
            "st": pa.array([{"a": 1, "b": "x"}, None, {"a": None, "b": "y"}], pa.struct([("a", pa.int64()), ("b", pa.string())])),
        }
    )


def test_each_cell_decodes_to_the_json_value():
    table = mixed_table()
    page = ipc_page(table, 0, table.num_rows)
    out = decode(page)
    assert page["rows"] == 3 and out.column_names == table.column_names
    types = {f.name: f.type for f in out.schema}
    assert types["small"] == pa.int64() and types["big"] == pa.string() and types["f64"] == pa.float64()
    assert types["ls"] == types["sv"] == types["dict"] == types["dec"] == pa.string()
    for name in table.column_names:
        original = table.column(name).to_pylist()
        got = out.column(name).to_pylist()
        if name in ("lst", "st"):
            assert [None if c is None else json.loads(c) for c in got] == [json_value(v) for v in original], name
        elif name == "f64":  # NaN stays a float (json_value sends it as "nan")
            assert got[0] == 1.5 and math.isnan(got[1]) and got[2] is None
        else:
            assert got == [json_value(v) for v in original], name
    # only the nested columns are JSON text
    assert {f.name for f in out.schema if f.metadata} == {"lst", "st"}
    assert out.schema.field("lst").metadata == {b"iara.cell": b"json"}


def test_an_int64_column_with_a_value_past_the_safe_range_is_text():
    table = pa.table({"n": pa.array([5, 2**60, None], pa.int64()), "u": pa.array([2**64 - 1, None, 1], pa.uint64())})
    shown = display_table(table)
    # one type per column: the in-range 5 is text too
    assert shown.column("n").to_pylist() == ["5", str(2**60), None]
    assert shown.column("u").to_pylist() == [str(2**64 - 1), None, "1"]
    # an all-null column of 64-bit integers stays an integer column
    nulls = display_table(pa.table({"n": pa.array([None, None], pa.int64())}))
    assert nulls.schema.field("n").type == pa.int64()


def test_arrow_page_selects_the_rows_page_selects(tmp_path: Path):
    store = ResultStore(spool=Spool(root=str(tmp_path)))
    rid = store.put(pa.table({"n": list(range(50)), "s": [f"v{i % 7}" for i in range(50)]}))["id"]
    cases = [
        (0, 10, None),
        (45, 10, None),
        (3, 5, [{"column": "n", "descending": True}]),
        (20, 4, [{"column": "s"}]),
        (5, 0, None),
        (60, 5, None),
        (-4, 3, None),
    ]
    for offset, limit, sort in cases:
        page = store.page(rid, offset, limit, sort)
        arrow = store.arrow_page(rid, offset, limit, sort)
        out = decode(arrow)
        assert (arrow["offset"], arrow["total"], arrow["rows"]) == (page["offset"], page["total"], len(page["rows"]))
        assert [list(r.values()) for r in out.to_pylist()] == page["rows"], (offset, limit, sort)


def test_the_byte_cap_sends_the_first_rows_that_fit():
    text = [f"{i:04d}" + "x" * 1000 for i in range(1000)]
    table = pa.table({"s": text})
    page = ipc_page(table, 0, 1000, max_bytes=64 << 10)
    out = decode(page)
    assert 1 < page["rows"] < 1000 and out.num_rows == page["rows"]
    assert len(base64.b64decode(page["data"])) <= 64 << 10
    assert out.column("s").to_pylist() == text[: page["rows"]]
    assert page["total"] == 1000 and page["offset"] == 0
    # one row is sent even when it is larger than the cap
    assert ipc_page(table, 0, 1000, max_bytes=1)["rows"] == 1


def call(session: KernelSession, method: str, params: dict[str, Any]) -> Any:
    return session.handlers()[method](params, lambda *a: None)


@pytest.fixture()
def session(workspace: Path):
    cwd = os.getcwd()
    s = KernelSession(workspace)
    yield s
    os.chdir(cwd)


def test_result_arrow_is_a_session_method(session: KernelSession):
    rid = call(session, "sql.run", {"query": "select id, amount from sales"})["result"]["id"]
    for params in [{"offset": 490, "limit": 50}, {"limit": 3, "sort": [{"column": "amount", "descending": True}]}]:
        page = session.results.page(rid, params.get("offset", 0), params["limit"], params.get("sort"))
        arrow = call(session, "result.arrow", {"result_id": rid, **params})
        assert arrow["total"] == page["total"] and arrow["offset"] == page["offset"]
        assert [list(r.values()) for r in decode(arrow).to_pylist()] == page["rows"]
    with pytest.raises(ValueError):
        call(session, "result.arrow", {"result_id": rid, "offset": -1})
    with pytest.raises(ValueError):
        call(session, "result.arrow", {"result_id": rid, "limit": -5})
