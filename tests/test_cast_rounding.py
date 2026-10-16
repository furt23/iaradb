"""Casting a fractional number to an integer rounds the same way from SQL and the
expression API: floats round half to even, decimals half away from zero (as DuckDB)."""

from __future__ import annotations

from decimal import Decimal

import duckdb
import pyarrow as pa
import pytest

import iara as ia
from iara import functions as F

FLOATS = [2.5, -2.5, 28.75, 3.5, -0.5, None]
FLOAT_INTS = [2, -2, 29, 4, 0, None]
DECIMALS = [Decimal("2.50"), Decimal("-2.50"), Decimal("28.75"), Decimal("3.49"), Decimal("-0.50"), None]
DECIMAL_INTS = [3, -3, 29, 3, -1, None]

CASES = [
    pytest.param(pa.float64(), FLOATS, FLOAT_INTS, id="float64"),
    pytest.param(pa.float32(), FLOATS, FLOAT_INTS, id="float32"),
    pytest.param(pa.decimal128(10, 2), DECIMALS, DECIMAL_INTS, id="decimal"),
]


def _table(dtype: pa.DataType, values: list) -> pa.Table:
    return pa.table({"x": pa.array(values, type=dtype)})


@pytest.mark.parametrize("dtype, values, expected", CASES)
@pytest.mark.parametrize("target", ["BIGINT", "INTEGER"])
def test_sql_cast(dtype: pa.DataType, values: list, expected: list, target: str) -> None:
    t = _table(dtype, values)
    got = ia.sql(f"SELECT CAST(x AS {target}) AS r FROM t", t=t).collect().to_arrow()
    assert got.column("r").to_pylist() == expected
    assert duckdb.sql(f"SELECT CAST(x AS {target}) AS r FROM t").fetchall() == [(v,) for v in expected]


@pytest.mark.parametrize("dtype, values, expected", CASES)
@pytest.mark.parametrize("target", ["Int64", "Int32"])
def test_api_cast(dtype: pa.DataType, values: list, expected: list, target: str) -> None:
    got = ia.from_arrow(_table(dtype, values)).lazy().select(F.col("x").cast(target).alias("r")).collect()
    assert got.to_arrow().column("r").to_pylist() == expected


def test_literal_casts() -> None:
    got = ia.sql(
        "SELECT CAST(28.75 AS BIGINT) a, CAST(2.5 AS BIGINT) b, CAST(-2.5 AS BIGINT) c,"
        " CAST(2.5::DOUBLE AS BIGINT) d, CAST(-2.5::DOUBLE AS BIGINT) e, CAST(NULL::DOUBLE AS BIGINT) f"
    ).collect().to_arrow()
    assert got.to_pylist() == [{"a": 29, "b": 3, "c": -3, "d": 2, "e": -2, "f": None}]


def test_non_strict_cast_out_of_range_is_null() -> None:
    t = _table(pa.float64(), [1e30, 1.5])
    got = ia.from_arrow(t).lazy().select(F.col("x").cast("Int32", strict=False).alias("r")).collect()
    assert got.to_arrow().column("r").to_pylist() == [None, 2]
