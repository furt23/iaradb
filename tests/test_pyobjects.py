"""Python values in and out of frames: the engine converts lists of integers, floats,
booleans and strings itself, and gives the same columns and values as pyarrow does."""

import datetime as dt
import decimal
import math

import pyarrow as pa
import pytest

import iara as ia
import iara.functions as F

PLAIN = {
    "ints": [1, -2, 3, 2**62],
    "ints_none": [None, 5, None, -7],
    "floats": [1.5, -0.0, float("inf"), 2.25],
    "floats_none": [None, None, 3.5, None],
    "ints_then_float": [1, 2, None, 2.5],
    "float_then_ints": [0.5, 2, 3, None],
    "bools": [True, False, None, True],
    "strs": ["a", "", "çã☃", "long " * 20],
    "strs_none": [None, "x", None, "y"],
}


def test_plain_columns_are_what_pyarrow_makes_of_them():
    got = ia.from_dict(PLAIN).to_arrow()
    want = pa.table(PLAIN)
    assert got.schema.names == want.schema.names
    assert [str(t) for t in got.schema.types] == [str(t) for t in want.schema.types]
    assert got.to_pydict() == want.to_pydict()


def test_tuples_and_other_sequences():
    data = {"t": (1, 2, None), "r": range(3), "a": pa.array(["x", None, "z"])}
    assert ia.from_dict(data).to_arrow().to_pydict() == pa.table({"t": [1, 2, None], "r": [0, 1, 2], "a": ["x", None, "z"]}).to_pydict()


def test_other_types_go_through_pyarrow():
    data = {
        "n": [1, 2, 3],
        "day": [dt.date(2024, 1, 2), None, dt.date(1999, 12, 31)],
        "at": [dt.datetime(2024, 1, 2, 3, 4, 5, 6), None, dt.datetime(1970, 1, 1)],
        "price": [decimal.Decimal("1.50"), decimal.Decimal("-2.25"), None],
        "tags": [["a"], [], None],
        "blob": [b"\x00\x01", None, b""],
        "nothing": [None, None, None],
    }
    got = ia.from_dict(data).to_arrow()
    want = pa.table(data)
    assert [str(t) for t in got.schema.types] == [str(t) for t in want.schema.types]
    assert got.to_pydict() == want.to_pydict()
    # and out again: plain columns by the engine, the others by pyarrow
    frame = ia.from_dict(data)
    assert frame.to_pydict() == want.to_pydict()
    assert frame.to_dicts() == want.to_pylist()
    assert frame.rows() == list(zip(*want.to_pydict().values()))


@pytest.mark.parametrize(
    "column",
    [
        [1, "a"],
        [True, 1],
        [1, True],
        ["a", 1.5],
        [2**60 + 1, 0.5],
        [0.5, 2**60 + 1],
        [1, 2**70],
        [2**63, 1, 2],
    ],
)
def test_mixed_columns_convert_or_fail_as_in_pyarrow(column):
    try:
        want = pa.table({"c": column})
    except (pa.ArrowInvalid, pa.ArrowTypeError, OverflowError) as error:
        with pytest.raises(type(error)):
            ia.from_dict({"c": column})
        return
    got = ia.from_dict({"c": column}).to_arrow()
    assert str(got.schema.types[0]) == str(want.schema.types[0])
    assert got.to_pydict() == want.to_pydict()


def test_subclasses_and_lone_surrogates_are_left_to_pyarrow():
    class Name(str):
        pass

    assert ia.from_dict({"s": [Name("a"), "b"]}).to_pydict() == {"s": ["a", "b"]}
    with pytest.raises(Exception):
        pa.table({"s": ["\ud800"]})
    with pytest.raises(Exception):
        ia.from_dict({"s": ["ok", "\ud800"]})


def test_columns_of_different_lengths_are_refused():
    with pytest.raises(ValueError):
        ia.from_dict({"a": [1, 2, 3], "b": ["x"]})


def test_empty_frames():
    assert ia.from_dict({}).shape == (0, 0)
    empty = ia.from_dict({"a": [], "b": []})
    assert empty.shape == (0, 2)
    assert empty.to_pydict() == {"a": [], "b": []}
    assert empty.to_dicts() == [] and empty.rows() == []


def test_values_come_back_as_python_values():
    frame = ia.from_dict(PLAIN)
    out = frame.to_pydict()
    assert out == pa.table(PLAIN).to_pydict()
    assert all(type(v) is int for v in out["ints"])
    assert all(v is None or type(v) is float for v in out["ints_then_float"])
    assert out["bools"] == [True, False, None, True] and out["bools"][0] is True
    assert math.copysign(1.0, out["floats"][1]) == -1.0
    assert frame.rows()[2] == (3, None, float("inf"), 3.5, None, 3, None, "çã☃", None)
    assert frame.to_dicts()[1]["strs_none"] == "x"


def test_query_results_of_every_width_convert():
    table = pa.table(
        {
            "i8": pa.array([1, None, -3], pa.int8()),
            "u16": pa.array([1, 2, None], pa.uint16()),
            "u64": pa.array([2**64 - 1, 0, None], pa.uint64()),
            "f32": pa.array([0.5, None, -1.25], pa.float32()),
            "big": pa.array(["a", None, "c"], pa.large_string()),
            "view": pa.array(["a", "b", None], pa.string_view()),
        }
    )
    frame = ia.from_arrow(table)
    assert frame.to_pydict() == table.to_pydict()
    # strings a query decodes as views, a sorted result, and one of several batches
    lazy = frame.lazy()
    assert lazy.sort("i8").collect().to_pydict()["i8"] == [-3, 1, None] or lazy.sort("i8").collect().to_pydict()["i8"] == [None, -3, 1]
    many = ia.from_dict({"n": list(range(50_000)), "s": [str(i) for i in range(50_000)]})
    out = many.lazy().filter(F.col("n") % 2 == 0).collect().to_pydict()
    assert out["n"] == list(range(0, 50_000, 2)) and out["s"][:3] == ["0", "2", "4"]
