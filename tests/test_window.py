"""Window functions (SQL and DataFrame API) and recursive CTEs, checked
against DuckDB and Polars."""

from __future__ import annotations

import os
import sys

import duckdb
import numpy as np
import pyarrow as pa
import pytest

import iara as ia
from iara import functions as F

sys.path.insert(0, os.path.dirname(__file__))
from compare import diff  # noqa: E402

N = 5000


def _with_nulls(rng, a, frac: float) -> pa.Array:
    return pa.array(a, mask=rng.random(len(a)) < frac)


@pytest.fixture(scope="module")
def tables() -> dict[str, pa.Table]:
    rng = np.random.default_rng(1)
    t = pa.table({
        "id": np.arange(N),
        "g": _with_nulls(rng, rng.integers(0, 7, N).astype(np.int32), 0.05),
        "x": _with_nulls(rng, rng.normal(10, 3, N), 0.1),
        "y": rng.integers(-50, 50, N),
        "s": _with_nulls(rng, np.array(["a", "b", "c", "dd", "e"])[rng.integers(0, 5, N)], 0.05),
        "d": (np.datetime64("2023-01-01") + rng.integers(0, 60, N).astype("timedelta64[D]")).astype("datetime64[D]"),
    })
    n = 2000
    emp = pa.table({
        "id": np.arange(n),
        "manager": pa.array([None] + [int(rng.integers(0, i)) for i in range(1, n)], type=pa.int64()),
    })
    edges = pa.table({"src": rng.integers(0, 300, 900), "dst": rng.integers(0, 300, 900)})
    return {"t": t, "emp": emp, "edges": edges}


@pytest.fixture(scope="module")
def duck(tables) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    for name, t in tables.items():
        con.register(name, t)
    return con


@pytest.fixture(scope="module")
def ctx(tables) -> ia.SessionContext:
    c = ia.SessionContext()
    for name, t in tables.items():
        c.register(name, t)
    return c


def check_sql(ctx, duck, sql: str, ordered: bool = False) -> None:
    res = ctx.sql(sql).collect().to_arrow()
    exp = duck.execute(sql).arrow()
    exp = exp.read_all() if hasattr(exp, "read_all") else exp
    d = diff(res, exp, ordered=ordered, rtol=1e-6)
    assert d is None, f"{sql}\n{d}"


WINDOW_SQL = [
    "select id, row_number() over (partition by g order by y, id) rn from t",
    "select id, rank() over (partition by g order by y) r, dense_rank() over (partition by g order by y) dr from t",
    "select id, percent_rank() over (partition by g order by y) pr, cume_dist() over (partition by g order by y) cd from t",
    "select id, ntile(4) over (partition by g order by y, id) nt from t",
    "select id, lag(y) over (partition by g order by id) l1, lead(y, 2, -1) over (partition by g order by id) l2 from t",
    "select id, lag(x, 1 ignore nulls) over (order by id) lx, lead(x ignore nulls) over (partition by g order by id) ld from t",
    "select id, sum(y) over (partition by g) s, count(*) over (partition by g) c, avg(x) over (partition by g) a from t",
    "select id, sum(y) over (partition by g order by id) cs from t",
    "select id, sum(y) over (partition by g order by y) cs from t",
    "select id, sum(x) over (order by id rows between 3 preceding and current row) ms from t",
    "select id, avg(x) over (order by id rows between 2 preceding and 2 following) ma from t",
    "select id, min(y) over (order by id rows between 5 preceding and current row) mn,"
    " max(s) over (order by id rows between 5 preceding and 1 following) mx from t",
    "select id, sum(y) over (partition by g order by y range between 5 preceding and 5 following) rs from t",
    "select id, count(*) over (order by d range between interval 3 days preceding and current row) c from t",
    "select id, sum(y) over (partition by g order by y groups between 1 preceding and 1 following) gs from t",
    "select id, first_value(y) over (partition by g order by id) f, last_value(y) over"
    " (partition by g order by id rows between unbounded preceding and unbounded following) l from t",
    "select id, nth_value(y, 3) over (partition by g order by id rows between unbounded preceding and unbounded following) n from t",
    "select id, first_value(x ignore nulls) over (partition by g order by id rows between 2 preceding and 2 following) f from t",
    "select id, stddev(x) over (partition by g order by id rows between 10 preceding and current row) sd,"
    " var_pop(x) over (partition by g) vp from t",
    "select id, count(distinct s) over (partition by g) dc, median(y) over (partition by g) md from t",
    "select id, sum(y) filter (where y > 0) over (partition by g order by id) sp from t",
    "select g, sum(y) s, rank() over (order by sum(y) desc) r from t group by g",
    "select g, count(*) c, sum(count(*)) over () total from t group by g",
    "select id, y from t qualify row_number() over (partition by g order by y desc, id) <= 2",
    "select id, row_number() over w rn, sum(y) over w s from t window w as (partition by g order by id)",
    "select id, y - avg(y) over (partition by g) dev from t",
    "select id, sum(y) over (order by id rows between 1 following and 3 following) f from t",
    "select id, sum(y) over (order by y desc range between 3 preceding and 1 preceding) f from t",
]

ORDERED_WINDOW_SQL = [
    "select id, row_number() over (order by id desc) rn from t order by rn limit 10",
    "select g, row_number() over (partition by g order by id) rn from t order by g nulls first, rn limit 20",
]

RECURSIVE_SQL = [
    "with recursive r(n) as (select 1 union all select n + 1 from r where n < 100) select sum(n), count(*) from r",
    "with recursive fib(i, a, b) as (select 1, 0::bigint, 1::bigint union all"
    " select i + 1, b, a + b from fib where i < 60) select * from fib",
    """with recursive chain as (
         select id, manager, 0 as depth from emp where manager is null
         union all
         select e.id, e.manager, c.depth + 1 from emp e join chain c on e.manager = c.id)
       select depth, count(*) c from chain group by depth""",
    """with recursive reach(node) as (
         select 0 union select e.dst from edges e join reach r on e.src = r.node)
       select count(*) from reach""",
    "with recursive r(x) as (select 'a' union all select x || 'a' from r where length(x) < 5) select * from r",
    "with recursive r(n, k) as (select 1, null union all select n + 1, n * 2 from r where n < 5) select * from r",
    "with recursive a as (select 1 as v union all select 2), b as (select v * 10 as w from a) select * from b",
]


@pytest.mark.parametrize("sql", WINDOW_SQL)
def test_window_sql(ctx, duck, sql):
    check_sql(ctx, duck, sql)


@pytest.mark.parametrize("sql", ORDERED_WINDOW_SQL)
def test_window_sql_ordered(ctx, duck, sql):
    check_sql(ctx, duck, sql, ordered=True)


@pytest.mark.parametrize("sql", RECURSIVE_SQL)
def test_recursive_cte(ctx, duck, sql):
    check_sql(ctx, duck, sql)


def test_recursive_cte_limit_stops_infinite_recursion(ctx):
    out = ctx.sql("with recursive r as (select 1 as n union all select n + 1 from r) select * from r limit 10")
    assert out.collect().to_arrow().num_rows == 10


@pytest.mark.parametrize(
    "sql, message",
    [
        ("select id from t where row_number() over (order by id) = 1", "QUALIFY"),
        ("select id from t qualify id > 3", "QUALIFY requires a window function"),
        ("select rank() over (partition by g) from t", "requires ORDER BY"),
    ],
)
def test_window_errors(ctx, sql, message):
    with pytest.raises(ia.IaraError, match=message):
        ctx.sql(sql).collect()


# ---------------------------------------------------------------------------
# DataFrame API vs Polars
# ---------------------------------------------------------------------------

pl = pytest.importorskip("polars")

API_CASES = {
    "sum_over": lambda c: [c("x").sum().over("g").alias("v")],
    "demean": lambda c: [(c("x") - c("x").mean()).over("g").alias("v")],
    "count_two_keys": lambda c: [c("x").count().over("g", "s").alias("v")],
    "rank_average": lambda c: [c("y").rank().alias("v")],
    "rank_min": lambda c: [c("y").rank("min").over("g").alias("v")],
    "rank_dense_desc": lambda c: [c("y").rank("dense", descending=True).over("g").alias("v")],
    "rank_max_nulls": lambda c: [c("x").rank("max").alias("v")],
    "rank_ordinal": lambda c: [c("x").rank("ordinal").over("g").alias("v")],
    "shift": lambda c: [c("x").shift(2).alias("v"), c("y").shift(-1, fill_value=-1).alias("w")],
    "shift_ordered": lambda c: [c("y").shift().over("g", order_by="id").alias("v")],
    "diff": lambda c: [c("y").diff().alias("v")],
    "cum_sum": lambda c: [c("x").cum_sum().alias("v"), c("y").cum_sum(reverse=True).alias("w")],
    "cum_min_max": lambda c: [c("y").cum_max().over("g").alias("v"), c("x").cum_min().over("g").alias("w")],
    "cum_count": lambda c: [c("x").cum_count().alias("v")],
    "rolling_mean": lambda c: [c("y").rolling_mean(5).alias("v")],
    "rolling_max_over": lambda c: [c("y").rolling_max(3).over("g").alias("v")],
    "rolling_std": lambda c: [c("y").rolling_std(6).alias("v")],
    "rolling_center": lambda c: [c("y").rolling_sum(3, center=True).alias("v")],
}


@pytest.mark.parametrize("name", list(API_CASES))
def test_window_api(tables, name):
    f = API_CASES[name]
    t = tables["t"].drop(["d"])
    res = ia.from_arrow(t).lazy().select([F.col("id"), *f(F.col)]).collect().to_arrow()
    exp = pl.from_arrow(t).lazy().select([pl.col("id"), *f(pl.col)]).collect().to_arrow()
    exp = exp.cast(res.schema)
    assert diff(res, exp, ordered=False, rtol=1e-6) is None


def test_window_api_rolling_min_periods(tables):
    t = tables["t"].select(["id", "x"])
    res = ia.from_arrow(t).select("id", F.col("x").rolling_sum(4, 2).alias("v")).to_arrow()
    exp = pl.from_arrow(t).select("id", pl.col("x").rolling_sum(4, min_samples=2).alias("v")).to_arrow()
    assert diff(res, exp.cast(res.schema), ordered=False, rtol=1e-6) is None


def test_window_api_filter_and_row_number(tables):
    df = ia.from_arrow(tables["t"])
    top = df.filter(F.col("y").rank("ordinal", descending=True).over("g") <= 2)
    assert top.columns == tables["t"].column_names
    exp = pl.from_arrow(tables["t"]).filter(pl.col("y").rank("ordinal", descending=True).over("g") <= 2)
    assert top.to_arrow().num_rows == exp.height
    firsts = df.with_columns(F.row_number().over("g", order_by="id").alias("rn")).filter(F.col("rn") == 1)
    assert firsts.to_arrow().num_rows == pl.from_arrow(tables["t"])["g"].n_unique()


def test_window_api_errors(tables):
    lf = ia.from_arrow(tables["t"]).lazy()
    with pytest.raises(ia.IaraError, match="over"):
        lf.select(F.col("x").over("g")).collect()
    with pytest.raises(ValueError, match="rank method"):
        F.col("x").rank("random")
