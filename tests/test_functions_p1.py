"""P1 scalar functions: SQL checked against DuckDB, the Expr API against Polars.

Needs the extension rebuilt (the functions live in the Rust engine).
"""

from __future__ import annotations

import datetime as dt
import os
import re
import sys

import duckdb
import polars as pl
import pyarrow as pa
import pyarrow.compute as pc
import pytest

import iara as ia
from iara import functions as F

sys.path.insert(0, os.path.dirname(__file__))
from compare import diff  # noqa: E402

D = dt.date
TS = dt.datetime


@pytest.fixture(scope="module")
def table() -> pa.Table:
    return pa.table(
        {
            "id": pa.array([1, 2, 3, 4, 5, 6, 7, 8], pa.int64()),
            "s": ["abc", None, "héllo wörld", "", "a1b22", "  pad  ", "ÀÉ ñu", "x,y,,z"],
            "n": pa.array([5, None, -3, 0, 5, 7, -8, 100], pa.int64()),
            "m": pa.array([5, None, 4, None, 6, 7, None, 100], pa.int64()),
            "f": pa.array([1.5, None, float("nan"), -2.0, 0.0, 3.25, -0.5, 1e9], pa.float64()),
            "d": pa.array(
                [D(2024, 2, 29), D(2023, 2, 28), None, D(2100, 2, 28), D(2024, 1, 31), D(2000, 12, 31), D(1969, 12, 31), D(2024, 3, 31)],
                pa.date32(),
            ),
            "d2": pa.array(
                [D(2024, 3, 1), D(2024, 2, 28), D(2024, 1, 1), None, D(2025, 1, 31), D(2000, 1, 1), D(1970, 1, 1), D(2023, 3, 31)],
                pa.date32(),
            ),
            "ts": pa.array(
                [
                    TS(2024, 2, 29, 23, 59, 58, 123456), TS(2023, 2, 28, 0, 0, 0), None, TS(2100, 2, 28, 12, 30, 0),
                    TS(2024, 1, 31, 1, 2, 3), TS(2000, 12, 31, 5, 6, 7), TS(1969, 12, 31, 23, 0, 0), TS(2024, 3, 31, 10, 0, 0),
                ],
                pa.timestamp("us"),
            ),
            "ds": ["2024-02-29", "2023-02-29", None, "2100-02-28", "not a date", "2000-12-31", "", "2024-03-31"],
            "tss": ["2024-02-29 23:59:58", "bad", None, "2100-02-28 12:30:00", "2024-01-31 01:02:03", "", "1969-12-31 23:00:00", "2024-03-31 10:00:00"],
            "y": pa.array([2024, 2023, 1999, 2100, 2000, 1970, 1, 2024], pa.int64()),
            "mo": pa.array([2, 2, 12, 2, 1, 6, 12, 3], pa.int64()),
            "dd": pa.array([29, 28, 31, 28, 1, 15, 31, 31], pa.int64()),
        }
    )


def check(table: pa.Table, ours: str, duck: str | None = None) -> None:
    """Run `SELECT <ours> FROM t` in Iara and `SELECT <duck>` in DuckDB."""
    res = ia.sql(f"SELECT {ours} AS r FROM t ORDER BY id", t=table).collect().to_arrow()
    con = duckdb.connect()
    con.register("t", table)
    exp = con.execute(f"SELECT {duck or ours} AS r FROM t ORDER BY id").arrow().read_all()
    d = diff(res, exp)
    assert d is None, f"{ours}: {d}"


def values(table: pa.Table, expr: str) -> list:
    out = ia.sql(f"SELECT {expr} AS r FROM t ORDER BY id", t=table).collect().to_arrow()
    return out.column(0).to_pylist()


MATH = [
    ("sign(n)", None),
    ("sign(f) * 1.0", "CASE WHEN isnan(f) THEN NULL ELSE sign(f) * 1.0 END"),
    ("isnan(f)", None),
    ("n % 3", None),
    ("mod(n, 3)", "n % 3"),
    ("f % 2", None),
    ("clip(n, -1, 3)", "CASE WHEN n IS NULL THEN NULL ELSE least(greatest(n, -1), 3) END"),
    ("n IS NOT DISTINCT FROM m", None),
    ("n IS DISTINCT FROM m", None),
    ("n <=> m", "n IS NOT DISTINCT FROM m"),
    ("equal_null(n, m)", "n IS NOT DISTINCT FROM m"),
    ("n IS NOT DISTINCT FROM 5", None),
    ("n IS NOT DISTINCT FROM NULL", None),
]

DATES = [
    ("date_add(d, 3)", "d + 3"),
    ("date_sub(d, 3)", "d - 3"),
    ("date_add(d, -366)", "d + -366"),
    ("datediff(d2, d)", "date_diff('day', d, d2)"),
    ("datediff('day', d, d2)", "date_diff('day', d, d2)"),
    ("datediff('month', d, d2)", "date_diff('month', d, d2)"),
    ("datediff('year', d, d2)", "date_diff('year', d, d2)"),
    ("datediff('quarter', d, d2)", "date_diff('quarter', d, d2)"),
    ("datediff('week', d, d2)", "date_diff('week', d, d2)"),
    ("datediff('hour', ts, ts + INTERVAL 90 MINUTE)", None),
    ("add_months(d, 1)", "CAST(d + INTERVAL 1 MONTH AS DATE)"),
    ("add_months(d, -13)", "CAST(d - INTERVAL 13 MONTH AS DATE)"),
    ("last_day(d)", None),
    ("last_day(ts)", "last_day(CAST(ts AS DATE))"),
    ("make_date(y, mo, dd)", None),
    ("strftime(ts, '%Y-%m-%d %H:%M:%S')", None),
    ("strftime(ts, '%Y %f')", None),
    ("strftime(d, '%d/%m/%y %j')", None),
    ("date_format(ts, 'yyyy-MM')", "strftime(ts, '%Y-%m')"),
    ("to_date(ds, '%Y-%m-%d')", "CAST(try_strptime(ds, '%Y-%m-%d') AS DATE)"),
    ("to_timestamp(tss, '%Y-%m-%d %H:%M:%S')", "try_strptime(tss, '%Y-%m-%d %H:%M:%S')"),
    ("to_date(ds, 'yyyy-MM-dd')", "CAST(try_strptime(ds, '%Y-%m-%d') AS DATE)"),
]

STRINGS = [
    ("lpad(s, 6, '*')", None),
    ("rpad(s, 6, 'xy')", None),
    ("lpad(s, 2, '*')", None),
    ("lpad(s, 4)", "lpad(s, 4, ' ')"),
    ("split_part(s, ' ', 2)", None),
    ("split_part(s, ',', 3)", None),
    ("concat_ws('-', s, 'x')", None),
    ("concat_ws(',', s, CAST(n AS VARCHAR), 'k')", None),
    ("repeat(s, 2)", None),
    ("repeat(s, 0)", None),
    ("regexp_like(s, '^a')", "regexp_matches(s, '^a')"),
    ("regexp_like(s, '[0-9]{2}')", "regexp_matches(s, '[0-9]{2}')"),
    ("s RLIKE 'o w'", "regexp_matches(s, 'o w')"),
    ("regexp_replace(s, '[0-9]+', '#')", None),
    ("regexp_replace(s, '[0-9]+', '#', 'g')", None),
    ("regexp_replace(s, '([a-z0-9])([a-z0-9])', '\\2\\1', 'g')", None),
    ("regexp_replace(s, 'É', 'e', 'i')", None),
    ("regexp_extract(s, '([a-z])([0-9]+)', 2)", None),
    ("regexp_extract(s, '[a-z]+')", None),
    ("regexp_extract(s, 'zzz')", None),
]


@pytest.mark.parametrize("ours,duck", MATH, ids=[c[0] for c in MATH])
def test_math_and_null_safe(table, ours, duck):
    check(table, ours, duck)


@pytest.mark.parametrize("ours,duck", DATES, ids=[c[0] for c in DATES])
def test_dates(table, ours, duck):
    check(table, ours, duck)


@pytest.mark.parametrize("ours,duck", STRINGS, ids=[c[0] for c in STRINGS])
def test_strings_and_regex(table, ours, duck):
    check(table, ours, duck)


def test_initcap_and_count(table):
    assert values(table, "initcap(s)") == ["Abc", None, "Héllo Wörld", "", "A1b22", "  Pad  ", "Àé Ñu", "X,Y,,Z"]
    pats = {"[0-9]+": [0, None, 0, 0, 2, 0, 0, 0], "": None, "[a-z]": None}
    assert values(table, "regexp_count(s, '[0-9]+')") == pats["[0-9]+"]
    expected = [None if v is None else len(re.findall("[a-zé]", v)) for v in table.column("s").to_pylist()]
    assert values(table, "regexp_count(s, '[a-zé]')") == expected


def test_edge_cases():
    t = pa.table({"s": pa.array([], pa.string()), "d": pa.array([], pa.date32())})
    assert ia.sql("SELECT lpad(s, 3, '0') AS a, last_day(d) AS b, regexp_like(s, 'a') AS c FROM t", t=t).collect().to_arrow().num_rows == 0
    one = ia.sql("SELECT make_date(2023, 2, 29) AS a, last_day(DATE '2024-02-10') AS b, zfill('-42', 6) AS c").collect().to_arrow()
    assert one.to_pylist() == [{"a": None, "b": D(2024, 2, 29), "c": "-00042"}]
    with pytest.raises(Exception):
        ia.sql("SELECT regexp_like('a', '(')").collect()


# ---- Python Expr API vs Polars --------------------------------------------


def both(table: pa.Table, build_wh, build_pl) -> None:
    res = ia.from_arrow(table).select(build_wh()).to_arrow()
    exp = pl.from_arrow(table).select(build_pl()).to_arrow()
    d = diff(res, exp)
    assert d is None, d


def test_expr_math(table):
    w, p = F.col, pl.col
    both(table, lambda: w("n").clip(-1, 3).alias("r"), lambda: p("n").clip(-1, 3).alias("r"))
    both(table, lambda: w("n").clip(None, 3).alias("r"), lambda: p("n").clip(upper_bound=3).alias("r"))
    both(table, lambda: w("n").sign().alias("r"), lambda: p("n").sign().alias("r"))
    both(table, lambda: w("f").is_nan().alias("r"), lambda: p("f").is_nan().alias("r"))
    both(table, lambda: (w("n") % 3).alias("r"), lambda: (p("n") % 3).alias("r"))
    both(table, lambda: w("n").eq_missing(w("m")).alias("r"), lambda: p("n").eq_missing(p("m")).alias("r"))


def test_expr_dates(table):
    w, p = F.col, pl.col
    both(table, lambda: w("ts").dt.strftime("%Y-%m-%d %H:%M").alias("r"), lambda: p("ts").dt.strftime("%Y-%m-%d %H:%M").alias("r"))
    both(table, lambda: w("d").dt.month_end().alias("r"), lambda: p("d").dt.month_end().alias("r"))
    both(table, lambda: w("d").dt.month_start().alias("r"), lambda: p("d").dt.month_start().alias("r"))
    both(table, lambda: w("d").dt.offset_by("1mo").alias("r"), lambda: p("d").dt.offset_by("1mo").alias("r"))
    both(table, lambda: w("d").dt.offset_by("-1y2d").alias("r"), lambda: p("d").dt.offset_by("-1y2d").alias("r"))
    both(table, lambda: w("ts").dt.offset_by("36h").alias("r"), lambda: p("ts").dt.offset_by("36h").alias("r"))
    ok = table.filter(pc.is_in(table["ds"], pa.array(["2024-02-29", "2100-02-28", "2000-12-31", "2024-03-31"])))
    both(ok, lambda: w("ds").str.to_date("%Y-%m-%d").alias("r"), lambda: p("ds").str.to_date("%Y-%m-%d").alias("r"))
    both(table, lambda: w("tss").str.to_datetime("%Y-%m-%d %H:%M:%S", strict=False).alias("r"),
         lambda: p("tss").str.to_datetime("%Y-%m-%d %H:%M:%S", strict=False).alias("r"))
    with pytest.raises(Exception):
        ia.from_arrow(table).select(F.col("ds").str.to_date("%Y-%m-%d"))


def test_expr_strings(table):
    w, p = F.col, pl.col
    both(table, lambda: w("s").str.contains("^a").alias("r"), lambda: p("s").str.contains("^a").alias("r"))
    both(table, lambda: w("s").str.contains("l.", literal=True).alias("r"), lambda: p("s").str.contains("l.", literal=True).alias("r"))
    both(table, lambda: w("s").str.replace("[0-9]+", "#").alias("r"), lambda: p("s").str.replace("[0-9]+", "#").alias("r"))
    both(table, lambda: w("s").str.replace_all("[0-9]", "#").alias("r"), lambda: p("s").str.replace_all("[0-9]", "#").alias("r"))
    both(table, lambda: w("s").str.replace_all("(\\w)(\\w)", "$2$1").alias("r"), lambda: p("s").str.replace_all("(\\w)(\\w)", "$2$1").alias("r"))
    both(table, lambda: w("s").str.replace("l.", "$", literal=True).alias("r"), lambda: p("s").str.replace("l.", "$", literal=True).alias("r"))
    both(table, lambda: w("s").str.extract("([a-z])([0-9]+)", 2).alias("r"), lambda: p("s").str.extract("([a-z])([0-9]+)", 2).alias("r"))
    both(table, lambda: w("s").str.extract("zzz").alias("r"), lambda: p("s").str.extract("zzz").alias("r"))
    both(table, lambda: w("s").str.count_matches("[0-9]").alias("r"), lambda: p("s").str.count_matches("[0-9]").cast(pl.Int64).alias("r"))
    both(table, lambda: w("s").str.pad_start(6, "*").alias("r"), lambda: p("s").str.pad_start(6, "*").alias("r"))
    both(table, lambda: w("s").str.pad_end(6, "*").alias("r"), lambda: p("s").str.pad_end(6, "*").alias("r"))
    nums = pa.table({"s": ["42", "-42", "+7", None, "123456", ""]})
    both(nums, lambda: w("s").str.zfill(5).alias("r"), lambda: p("s").str.zfill(5).alias("r"))


def test_length_counts_characters_strlen_bytes() -> None:
    # inline (up to 12 bytes) and buffered strings, ASCII and not, NULL
    vals = ["", "abc", "twelve bytes", "thirteen bytes", "héllo wörld", "ação longa demais para caber", None]
    for typ in (pa.string_view(), pa.string()):
        t = pa.table({"s": pa.array(vals, typ)})
        got = ia.sql("select length(s) as n, strlen(s) as m, octet_length(s) as o from t", t=t).collect().to_arrow().to_pylist()
        chars = [None if v is None else len(v) for v in vals]
        octets = [None if v is None else len(v.encode()) for v in vals]
        assert [r["n"] for r in got] == chars, typ
        assert [r["m"] for r in got] == octets and [r["o"] for r in got] == octets, typ
        df = ia.from_arrow(t).select(F.col("s").str.len_bytes().alias("b")).to_arrow()
        assert df.column("b").to_pylist() == octets, typ
