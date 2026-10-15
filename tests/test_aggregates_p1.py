"""P1 aggregates: SQL checked against DuckDB, the Expr API against Polars.

Needs the extension rebuilt (the aggregates live in the Rust engine), and the
`PyExpr.agg_with` binding for the multi-argument Expr methods.
"""

from __future__ import annotations

import os
import sys

import duckdb
import polars as pl
import pyarrow as pa
import pytest

import workhouse as wh
from workhouse import functions as F

sys.path.insert(0, os.path.dirname(__file__))
from compare import diff  # noqa: E402


@pytest.fixture(scope="module")
def table() -> pa.Table:
    return pa.table(
        {
            "id": pa.array(list(range(1, 13)), pa.int64()),
            "g": pa.array([1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5], pa.int64()),
            "x": pa.array([3, 1, None, 5, 5, 2, None, None, 7, 8, 9, 4], pa.int64()),
            "y": pa.array([1.5, None, 2.5, 4.0, 3.0, None, 1.0, 2.0, 7.0, 6.5, 8.0, None], pa.float64()),
            "b": pa.array([True, False, None, True, True, True, None, None, False, False, True, False]),
            "s": ["b", "a", None, "d", "d", "c", "é", None, "z", "y", "x", "w"],
        }
    )


def check(table: pa.Table, query: str, duck: str | None = None) -> None:
    ours = wh.sql(query, t=table).collect().to_arrow()
    con = duckdb.connect()
    con.register("t", table)
    exp = con.execute(duck or query).arrow().read_all()
    d = diff(ours, exp)
    assert d is None, f"{query}: {d}"


GROUPED = [
    "quantile_cont(x, 0.5)",
    "quantile_cont(y, 0.25)",
    "quantile_disc(x, 0.5)",
    "quantile_disc(x, 0.75)",
    "quantile_disc(y, 0)",
    "median(x)",
    "approx_quantile(x, 0.5)",
    "count_if(x > 2)",
    "count_if(b)",
    "bool_and(b)",
    "bool_or(b)",
    "product(x)",
    "max_by(s, x)",
    "min_by(s, x)",
    "max_by(x, id)",
    "arg_max(id, y)",
    "sum(DISTINCT x)",
    "sum(DISTINCT y)",
    "corr(x, y)",
    "covar_samp(x, y)",
    "covar_pop(x, y)",
    "regr_slope(y, x)",
]

# DuckDB spellings that differ
DUCK = {
    "count_if(b)": "count_if(b)",
    "arg_max(id, y)": "arg_max(id, y)",
    "approx_quantile(x, 0.5)": "CAST(trunc(quantile_cont(x, 0.5)) AS BIGINT)",
}


@pytest.mark.parametrize("agg", GROUPED)
def test_grouped(table: pa.Table, agg: str) -> None:
    sql = f"SELECT g, {agg} AS r FROM t GROUP BY g ORDER BY g"
    check(table, sql, f"SELECT g, {DUCK.get(agg, agg)} AS r FROM t GROUP BY g ORDER BY g")


@pytest.mark.parametrize("agg", GROUPED)
def test_ungrouped_and_empty(table: pa.Table, agg: str) -> None:
    for where in ("true", "false", "x IS NULL"):
        sql = f"SELECT {agg} AS r FROM t WHERE {where}"
        check(table, sql, f"SELECT {DUCK.get(agg, agg)} AS r FROM t WHERE {where}")


def test_quantile_edges(table: pa.Table) -> None:
    for p in (0, 0.1, 0.5, 0.99, 1):
        check(table, f"SELECT quantile_cont(y, {p}) c, quantile_disc(y, {p}) d, quantile_disc(x, {p}) e FROM t")
    with pytest.raises(Exception):
        wh.sql("SELECT quantile_cont(x, 1.5) FROM t", t=table).collect()


def test_within_group(table: pa.Table) -> None:
    check(
        table,
        "SELECT g, percentile_cont(0.3) WITHIN GROUP (ORDER BY y) AS a, "
        "percentile_cont(0.3) WITHIN GROUP (ORDER BY y DESC) AS d, "
        "percentile_disc(0.5) WITHIN GROUP (ORDER BY x) AS c FROM t GROUP BY g ORDER BY g",
    )


def test_filter_and_window(table: pa.Table) -> None:
    check(table, "SELECT g, quantile_cont(y, 0.5) FILTER (WHERE x > 1) AS r, count_if(x > 2) FILTER (WHERE id > 3) AS c FROM t GROUP BY g ORDER BY g")
    check(
        table,
        "SELECT id, quantile_cont(y, 0.5) OVER (PARTITION BY g) AS q, bool_and(b) OVER (PARTITION BY g) AS a, "
        "max_by(s, x) OVER (PARTITION BY g) AS m FROM t ORDER BY id",
    )


def test_large_group_count_radix_path() -> None:
    n = 400_000
    big = pa.table(
        {
            "k": pa.array([(i * 7919) % 100_003 for i in range(n)], pa.int64()),
            "x": pa.array([(i * 31) % 1009 for i in range(n)], pa.int64()),
            "y": pa.array([float((i * 17) % 503) for i in range(n)], pa.float64()),
            "i": pa.array(list(range(n)), pa.int64()),
        }
    )
    q = (
        "SELECT k, quantile_cont(x, 0.5) a, quantile_disc(x, 0.2) b, count_if(x > 500) c, max_by(i, x * 1000000 + i) m, "
        "corr(x, y) r, sum(DISTINCT x) sd FROM t GROUP BY k ORDER BY k"
    )
    check(big, q)


def test_rollup_cube_grouping_sets(table: pa.Table) -> None:
    order = "ORDER BY 1 NULLS LAST, 2 NULLS LAST, 3, 4"
    for gb in ("ROLLUP(g, b)", "CUBE(g, b)", "GROUPING SETS ((g), (b), ())", "g, ROLLUP(b)", "ROLLUP(g), ROLLUP(b)"):
        check(table, f"SELECT g, b, grouping(g) gg, grouping(g, b) gb, count(*) n, sum(x) s FROM t GROUP BY {gb} {order}")
    check(table, "SELECT g, sum(x) s FROM t GROUP BY ROLLUP(g) HAVING sum(x) > 5 ORDER BY 1 NULLS LAST")
    check(table, "SELECT g, sum(x) s FROM t WHERE false GROUP BY ROLLUP(g)")
    check(table, "SELECT coalesce(CAST(g AS VARCHAR), 'ALL') k, sum(x) s FROM t GROUP BY ROLLUP(g) ORDER BY k")


def test_grouping_outside_rollup_is_an_error(table: pa.Table) -> None:
    with pytest.raises(Exception):
        wh.sql("SELECT grouping(g) FROM t GROUP BY g", t=table).collect()


def test_trig(table: pa.Table) -> None:
    for fn in ("sin", "cos", "tan", "atan", "degrees", "radians"):
        check(table, f"SELECT {fn}(y) AS r FROM t ORDER BY id")
    check(table, "SELECT asin(y / 10) a, acos(y / 10) c, atan2(y, x) t, pi() p FROM t ORDER BY id")


def test_now_is_constant_per_query(table: pa.Table) -> None:
    out = wh.sql(
        "SELECT count(DISTINCT now()) n, min(now()) <= max(current_timestamp) ok, year(current_date) y FROM t", t=table
    ).collect().to_arrow()
    assert out.column("n")[0].as_py() == 1
    assert out.column("ok")[0].as_py() is True
    assert out.column("y")[0].as_py() >= 2026


def test_random(table: pa.Table) -> None:
    out = wh.sql("SELECT random() r FROM t", t=table).collect().to_arrow().column("r").to_pylist()
    assert len(set(out)) == len(out) and all(0 <= v < 1 for v in out)
    a = wh.sql("SELECT random(5, id) r FROM t ORDER BY id", t=table).collect().to_arrow().column("r").to_pylist()
    b = wh.sql("SELECT rand(5, id) r FROM t ORDER BY id", t=table).collect().to_arrow().column("r").to_pylist()
    assert a == b and len(set(a)) == len(a)


# ---- Expr API (Polars semantics) ------------------------------------------
def _pl(table: pa.Table) -> pl.DataFrame:
    return pl.from_arrow(table)


def _ours(table: pa.Table, *aggs: wh.Expr) -> pa.Table:
    return wh.from_arrow(table).lazy().group_by("g").agg(*aggs).sort("g").collect().to_arrow()


def test_expr_quantile_median_product(table: pa.Table) -> None:
    out = _ours(
        table,
        F.col("y").quantile(0.3).alias("q"),
        F.col("y").median().alias("m"),
        F.col("x").quantile(0.5, "disc").alias("d"),
        F.col("x").product().alias("p"),
    )
    exp = _pl(table).group_by("g").agg(
        pl.col("y").quantile(0.3, "linear").alias("q"),
        pl.col("y").median().alias("m"),
        pl.col("x").quantile(0.5, "lower").alias("d"),
        pl.col("x").cast(pl.Float64).product().alias("p"),
    ).sort("g")
    # Polars' product of an all-null group is 1; SQL (DuckDB) gives null
    assert diff(out.select(["g", "q", "m"]), exp.to_arrow().select(["g", "q", "m"])) is None


def test_expr_bool_and_by(table: pa.Table) -> None:
    out = _ours(
        table,
        F.col("b").all().alias("a"),
        F.col("b").any().alias("o"),
        F.col("s").max_by("x").alias("mx"),
        F.col("s").min_by("x").alias("mn"),
        F.count_if(F.col("x") > 2).alias("c"),
    ).to_pydict()
    assert out["a"] == [False, True, None, False, False]
    assert out["o"] == [True, True, None, True, False]
    assert out["c"] == [1, 2, 0, 3, 1]


def test_expr_corr_and_trig(table: pa.Table) -> None:
    out = wh.from_arrow(table).lazy().agg(F.col("x").corr(F.col("y")).alias("r")).collect().to_dicts()[0]["r"]
    exp = _pl(table).select(pl.corr("x", "y")).item()
    assert out == pytest.approx(exp)
    t = wh.from_arrow(table).lazy().select(F.col("y").sin().alias("s"), F.col("y").arctan2(F.col("y")).alias("a")).collect().to_arrow()
    assert t.column("s").to_pylist() == pytest.approx(_pl(table).select(pl.col("y").sin()).to_series().to_list(), nan_ok=True)
