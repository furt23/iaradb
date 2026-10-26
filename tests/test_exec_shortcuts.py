"""Execution shortcuts checked against DuckDB: a filter whose mask is handed to
the aggregate instead of compacting the batch, SUM/AVG sharing one state,
cached group ids for 1-byte strings and small key pairs, window-evaluated
correlated subqueries, whole-partition windows without a sort, and lazily
gathered sort results.
"""

from __future__ import annotations

import os
import sys
from decimal import Decimal

import duckdb
import numpy as np
import pyarrow as pa
import pytest

import iara as ia

sys.path.insert(0, os.path.dirname(__file__))
from compare import diff  # noqa: E402

N = 200_000


@pytest.fixture(scope="module")
def t() -> pa.Table:
    rng = np.random.default_rng(7)
    flag = rng.choice(["A", "N", "R", ""], N)
    k = rng.integers(0, 50, N)
    v = rng.integers(-1000, 1000, N).astype("float64")
    v[rng.random(N) < 0.05] = np.nan
    return pa.table(
        {
            "flag": pa.array(flag, pa.string_view()),
            "status": pa.array(rng.choice(["F", "O"], N)),
            "k": pa.array(k, pa.int64()),
            # many distinct values, and keys that only filtered-out rows have
            "wide": pa.array(np.where(rng.random(N) < 0.8, rng.integers(0, 50_000, N), 10_000_000 + np.arange(N)), pa.int64()),
            "v": pa.array(v, pa.float64(), from_pandas=True),
            "d": pa.array([Decimal(int(x)) / 100 for x in rng.integers(0, 1_000_000, N)], pa.decimal128(15, 2)),
            "sel": pa.array(rng.random(N), pa.float64()),
        }
    )


def check(query: str, ordered: bool = False, **tables: pa.Table) -> None:
    ours = ia.sql(query, **tables).collect().to_arrow()
    con = duckdb.connect()
    for name, tbl in tables.items():
        con.register(name, tbl)
    exp = con.execute(query).fetch_arrow_table()
    d = diff(ours, exp, ordered=ordered, rtol=1e-9)
    assert d is None, f"{query}: {d}"


@pytest.mark.parametrize("where", ["sel < 0.8", "sel < 0.3", "sel >= 0", "wide < 10000000"])
def test_filter_into_grouped_aggregate(t: pa.Table, where: str) -> None:
    # 1-byte string keys, a 2-column key, decimal and float SUM/AVG pairs, counts
    check(
        f"""select flag, status, count(*) c, count(v) cv, sum(v) sv, avg(v) av, sum(d) sd, avg(d) ad,
                   min(d) mn, max(v) mx
            from t where {where} group by flag, status""",
        t=t,
    )
    check(f"select k, flag, sum(d) s, avg(d) a, sum(d) s2 from t where {where} group by k, flag", t=t)


def test_filter_into_wide_aggregate(t: pa.Table) -> None:
    # many groups: the aggregate partitions its input, and groups only filtered rows have must not appear
    check("select wide, count(*) c, sum(v) s, avg(v) a from t where wide < 10000000 and sel < 0.9 group by wide", t=t)


def test_filtered_aggregate_keeps_fallible_expressions_on_kept_rows() -> None:
    tbl = pa.table({"g": [1, 1, 2, 2] * 1000, "x": [0, 2, 0, 4] * 1000})
    # x = 0 rows are filtered out; dividing by them must not be evaluated
    check("select g, sum(10 / x) s from t where x <> 0 group by g", t=tbl)


def test_agg_filter_clause_with_shared_state(t: pa.Table) -> None:
    check(
        """select flag, sum(v) filter (where k < 10) s, avg(v) filter (where k < 10) a, avg(v) a2, count(*) filter (where k > 40) c
           from t group by flag""",
        t=t,
    )


def test_correlated_avg_as_window() -> None:
    rng = np.random.default_rng(3)
    n = 20_000
    item = pa.table({"i_part": rng.integers(0, 500, n), "i_qty": rng.integers(1, 50, n).astype("float64")})
    part = pa.table({"p_key": np.arange(500), "p_brand": rng.choice(["x", "y", "z"], 500)})
    q17 = """select sum(i_qty) s, count(*) c from item, part
             where p_key = i_part and p_brand = 'x'
               and i_qty < (select 0.5 * avg(i_qty) from item where i_part = p_key)"""
    check(q17, item=item, part=part)
    # a filter on the shared table that the subquery does not repeat: the subquery still sees every row
    check(
        """select count(*) c from item, part
           where p_key = i_part and p_brand = 'y' and i_qty > 10
             and i_qty < (select avg(i_qty) from item where i_part = p_key)""",
        item=item,
        part=part,
    )
    check(
        """select p_key, min(i_qty) m from item, part
           where p_key = i_part and i_qty = (select min(i_qty) from item where i_part = p_key)
           group by p_key""",
        item=item,
        part=part,
    )


def test_whole_partition_window_without_order(t: pa.Table) -> None:
    check(
        """select k, v, sum(v) over (partition by k) s, avg(d) over (partition by k, flag) a,
                  count(*) filter (where sel < 0.5) over (partition by flag) c
           from t""",
        t=t,
    )


def test_sorted_frame_is_gathered_on_demand(t: pa.Table) -> None:
    df = ia.from_arrow(t).lazy().sort("v", "k", descending=[True, False]).collect()
    full = df.to_arrow()
    assert df.height == N
    head = df.head(7).to_arrow()
    assert head.equals(full.slice(0, 7))
    assert df.slice(1000, 5).to_arrow().equals(full.slice(1000, 5))
    # nulls first, as in Polars
    expected = t.select(["v", "k"]).sort_by([("v", "descending"), ("k", "ascending")], null_placement="at_start")
    assert diff(full.select(["v", "k"]), expected, ordered=True) is None


def test_to_pandas_leaves_the_frame_intact(t: pa.Table) -> None:
    df = ia.sql("select k, v from t", t=t).collect()
    first = df.to_pandas()
    second = df.to_pandas()
    assert len(first) == len(second) == df.height == N


def test_to_pandas_decimals_stay_exact() -> None:
    import decimal

    import pandas as pd

    t = pa.table({"d": pa.array([decimal.Decimal("1.25"), None, decimal.Decimal("-3.10")], pa.decimal128(15, 2)), "i": [1, 2, 3]})
    out = ia.from_arrow(t).to_pandas()
    assert out["d"].dtype == pd.ArrowDtype(pa.decimal128(15, 2))
    assert out["d"].tolist()[0] == decimal.Decimal("1.25") and pd.isna(out["d"].tolist()[1])
    assert out["i"].dtype == "int64"
    # a mapper of the caller still applies
    mapped = ia.from_arrow(t).to_pandas(types_mapper=lambda ty: pd.Int64Dtype() if ty == pa.int64() else None)
    assert mapped["i"].dtype == pd.Int64Dtype() and mapped["d"].dtype == pd.ArrowDtype(pa.decimal128(15, 2))
