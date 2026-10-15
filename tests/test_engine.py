"""End-to-end tests: Workhouse results are checked against DuckDB."""

from __future__ import annotations

import datetime as dt
import os
import sys

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import workhouse as wh
from workhouse import functions as F

sys.path.insert(0, os.path.dirname(__file__))
from compare import diff  # noqa: E402

N = 200_000


@pytest.fixture(scope="module")
def tables() -> dict[str, pa.Table]:
    rng = np.random.default_rng(42)

    def with_nulls(arr: np.ndarray, frac: float) -> pa.Array:
        mask = rng.random(arr.shape[0]) < frac
        return pa.array(arr, mask=mask)

    words = np.array(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "ι-iota", ""])
    facts = pa.table(
        {
            "id": pa.array(np.arange(N, dtype=np.int64)),
            "k_small": with_nulls(rng.integers(0, 10, N).astype(np.int32), 0.05),
            "k_big": pa.array(rng.integers(0, 50_000, N).astype(np.int64)),
            "cat": with_nulls(words[rng.integers(0, len(words), N)], 0.03),
            "x": with_nulls(rng.normal(100, 25, N), 0.1),
            "y": pa.array(rng.integers(-1000, 1000, N).astype(np.int64)),
            "flag": pa.array(rng.random(N) < 0.3),
            "d": pa.array(
                (np.datetime64("2020-01-01") + rng.integers(0, 1500, N).astype("timedelta64[D]")).astype("datetime64[D]")
            ),
        }
    )
    dims = pa.table(
        {
            "k": pa.array(np.arange(0, 60_000, 2, dtype=np.int64)),  # only even keys -> unmatched rows
            "label": pa.array([f"L{i % 97}" for i in range(30_000)]),
            "weight": pa.array(rng.random(30_000)),
        }
    )
    small = pa.table({"k_small": pa.array([0, 1, 2, 3, 3, 11], type=pa.int32()), "name": ["zero", "one", "two", "three", "three-b", "eleven"]})
    return {"facts": facts, "dims": dims, "small": small}


@pytest.fixture(scope="module")
def duck(tables) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    for name, t in tables.items():
        con.register(name, t)
    return con


@pytest.fixture(scope="module")
def ctx(tables) -> wh.SessionContext:
    c = wh.SessionContext()
    for name, t in tables.items():
        c.register(name, t)
    return c


def duck_arrow(con, sql: str) -> pa.Table:
    r = con.execute(sql).arrow()
    return r.read_all() if hasattr(r, "read_all") else r


def check_sql(ctx, duck, sql: str, ordered: bool = False, rtol: float = 1e-9) -> None:
    res = ctx.sql(sql).collect().to_arrow()
    exp = duck_arrow(duck, sql)
    d = diff(res, exp, ordered=ordered, rtol=rtol)
    assert d is None, f"{d}\nSQL: {sql}"


def check_frame(frame: wh.LazyFrame | wh.DataFrame, duck, sql: str, ordered: bool = False, rtol: float = 1e-9) -> None:
    res = (frame.collect() if isinstance(frame, wh.LazyFrame) else frame).to_arrow()
    exp = duck_arrow(duck, sql)
    d = diff(res, exp, ordered=ordered, rtol=rtol)
    assert d is None, f"{d}\nSQL: {sql}"


# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------

SQL_CASES = [
    "select * from facts where x > 120 and y < 0",
    "select id, x * 2 + y as v, -y as ny, y % 7 as m, y / 3 as q from facts where flag",
    "select count(*), count(x), sum(x), avg(x), min(x), max(x), sum(y), min(cat), max(cat) from facts",
    "select k_small, count(*) c, sum(x) s, avg(y) a, min(d) mn, max(d) mx from facts group by k_small",
    "select cat, k_small, count(*) c, sum(y) s from facts group by cat, k_small",
    "select cat, k_small, flag, count(*) c from facts group by 1, 2, 3",
    "select k_big, count(*) c, sum(x) s from facts group by k_big",
    "select count(distinct k_big), count(distinct cat) from facts",
    "select k_small, count(distinct cat) as dc, stddev(x) sd, variance(y) va, median(y) md from facts group by k_small",
    "select k_small, sum(x) s from facts group by k_small having sum(x) > 1000 and count(*) > 10",
    "select cat, sum(y) filter (where flag) as sf, count(*) filter (where x > 100) cf from facts group by cat",
    "select f.id, f.k_big, d.label, d.weight from facts f join dims d on f.k_big = d.k",
    "select f.id, d.label from facts f left join dims d on f.k_big = d.k",
    "select f.id, d.k from facts f right join dims d on f.k_big = d.k and f.id < 1000",
    "select f.id, d.k from facts f full outer join dims d on f.k_big = d.k and f.y > 900",
    "select f.id, f.y from facts f where exists (select 1 from dims d where d.k = f.k_big and d.weight > 0.5)",
    "select f.id from facts f where not exists (select 1 from dims d where d.k = f.k_big)",
    "select id from facts where k_big in (select k from dims where weight < 0.1)",
    "select id from facts where k_big not in (select k from dims where weight < 0.9)",
    "select f.id, s.name from facts f join small s on f.k_small = s.k_small",
    "select k_small, count(*) c, min(name) n from facts join small using (k_small) group by k_small",
    "select * from small full join (select distinct k_small from facts) t using (k_small)",
    "select k_small, name from small natural left join (select distinct k_small, flag from facts) t",
    "select f.id, s.name from facts f, small s where f.k_small = s.k_small and f.y > s.k_small * 100",
    "select id, x from facts where x > (select avg(x) from facts)",
    "select f.id from facts f where f.y > (select avg(g.y) from facts g where g.k_small = f.k_small)",
    "select id, case when x > 120 then 'high' when x > 80 then 'mid' when x is null then 'none' else 'low' end as b from facts",
    "select id, case k_small when 1 then 'one' when 2 then 'two' end as n from facts",
    "select id, coalesce(x, y, 0) c, nullif(k_small, 3) n, greatest(y, 0) g, least(y, 0) l from facts",
    "select id, upper(cat) u, lower(cat) lo, length(cat) ln, substring(cat, 2, 3) ss, cat || '-' || cast(k_small as varchar) cc from facts",
    "select id from facts where cat like 'a%' or cat like '%ta' or cat ilike 'GAM%' or cat not like '%e%'",
    "select id, trim('  ' || cat || ' ') t, replace(cat, 'a', 'A') r, reverse(cat) rv, strpos(cat, 'ta') p from facts",
    "select id, starts_with(cat, 'del') sw, ends_with(cat, 'ta') ew, contains(cat, 'mm') ct from facts",
    "select id, year(d) y, month(d) m, day(d) dd, quarter(d) q, dayofweek(d) w, dayofyear(d) doy from facts",
    "select id, d + interval '3' day as d3, d - interval '1' month as dm from facts where d >= date '2022-06-01'",
    "select date_trunc('month', d) as m, count(*) from facts group by 1",
    "select id, extract(year from d) y from facts where d between date '2021-01-01' and date '2021-03-31'",
    "select id, abs(y) a, round(x, 2) r, sqrt(abs(x)) s, floor(x) fl, ceil(x) ce, power(abs(y), 0.5) pw from facts",
    "select id, x from facts where x is null",
    "select id from facts where k_small in (1, 3, 5, 7) and cat in ('alpha', 'beta', 'gamma')",
    "select id from facts where k_small not in (1, 3, 5, 7)",
    "select distinct k_small, flag from facts",
    "select k_small from facts union all select k_small from small",
    "select k_small from facts union select k_small from small",
    "select k_small from small except select k_small from facts",
    "select k_small from small intersect select k_small from facts",
    "with a as (select k_small, sum(y) s from facts group by k_small), b as (select * from a where s > 0) select * from b",
    "select * from (select k_small, count(*) c from facts group by k_small) t where c > 100",
    "select cast(y as double) / 4 as q, cast(x as integer) as xi, cast(id as varchar) s from facts",
    "select * from (values (1, 'a'), (2, 'b'), (3, null)) as t(n, s)",
    "select 1 + 2 as three, 'x' as s, null as n, 2.5 * 2 as f",
    # wide keys functionally dependent on an integer column (dependent group-by mode)
    "select f.k_big, d.label, d.weight, count(*) c, sum(f.y) s from facts f join dims d on f.k_big = d.k group by f.k_big, d.label, d.weight",
    "select id, d, x, flag, cat, y from facts group by id, d, x, flag, cat, y",
    # ... and keys where the dependency breaks early, late, or never gets data
    "select k_big, cat, count(*) c from facts group by k_big, cat",
    "select k_small, cat, flag, count(*) c from facts group by k_small, cat, flag",
    "select y, k_big, d, count(*) c from facts where id < 50000 group by y, k_big, d",
    "select cast(floor(id / 2) as bigint) as g, case when id < 150000 then 0 else k_small end as v, count(*) c from facts group by 1, 2",
    "select k_big, cat, count(*) c from facts where y > 5000 group by k_big, cat",
]

ORDERED_SQL_CASES = [
    "select id, x from facts order by x desc nulls last, id limit 25",
    "select id, y from facts order by y, id desc limit 50 offset 10",
    "select cat, count(*) c from facts group by cat order by c desc, cat",
    "select k_small, sum(y) s from facts group by k_small order by 2 desc nulls last",
    "select id, x from facts order by abs(y) desc, id limit 10",
    "select id from facts order by k_big desc, id",
    "select cat from facts order by cat nulls first, id limit 100",
]


@pytest.mark.parametrize("sql", SQL_CASES)
def test_sql(ctx, duck, sql):
    check_sql(ctx, duck, sql, rtol=1e-6)


@pytest.mark.parametrize("sql", ORDERED_SQL_CASES)
def test_sql_ordered(ctx, duck, sql):
    check_sql(ctx, duck, sql, ordered=True, rtol=1e-6)


# ---------------------------------------------------------------------------
# DataFrame API
# ---------------------------------------------------------------------------


def test_api_filter_select(tables, duck):
    lf = wh.from_arrow(tables["facts"]).lazy()
    out = lf.filter((F.col("x") > 100) & ~F.col("flag")).select("id", (F.col("x") * 2).alias("x2"), F.col("cat"))
    check_frame(out, duck, "select id, x * 2 as x2, cat from facts where x > 100 and not flag")


def test_api_with_columns_and_naming(tables, duck):
    lf = wh.from_arrow(tables["facts"]).lazy()
    out = lf.with_columns(F.col("y") * 10, z=F.col("x") + F.col("y")).select("id", "y", "z")
    assert out.columns == ["id", "y", "z"]
    check_frame(out, duck, "select id, y * 10 as y, x + y as z from facts")


def test_api_group_by(tables, duck):
    lf = wh.from_arrow(tables["facts"]).lazy()
    out = lf.group_by("cat", "k_small").agg(
        F.col("x").sum().alias("sx"),
        F.col("y").mean().alias("my"),
        F.col("id").count().alias("n"),
        F.col("k_big").n_unique().alias("u"),
        (F.col("x").sum() / F.col("y").count()).alias("ratio"),
        F.col("y").filter(F.col("flag")).sum().alias("yf"),
    )
    check_frame(
        out,
        duck,
        "select cat, k_small, sum(x) sx, avg(y) my, count(id) n, count(distinct k_big) u, "
        "sum(x) / count(y) ratio, sum(y) filter (where flag) yf from facts group by cat, k_small",
        rtol=1e-6,
    )


def test_api_group_by_expression_key(tables, duck):
    lf = wh.from_arrow(tables["facts"]).lazy()
    out = lf.group_by(F.col("d").dt.year().alias("yr")).agg(F.len())
    check_frame(out, duck, "select year(d) yr, count(*) len from facts group by 1")


def test_api_global_agg(tables, duck):
    lf = wh.from_arrow(tables["facts"]).lazy()
    out = lf.select(F.col("x").sum(), F.col("y").max(), F.col("x").std().alias("sd"))
    check_frame(out, duck, "select sum(x) x, max(y) y, stddev(x) sd from facts", rtol=1e-6)


@pytest.mark.parametrize("how", ["inner", "left", "semi", "anti", "full"])
def test_api_join(tables, duck, how):
    f = wh.from_arrow(tables["facts"]).lazy().select("id", "k_big", "y")
    d = wh.from_arrow(tables["dims"]).lazy()
    out = f.join(d, left_on="k_big", right_on="k", how=how)
    sqljoin = {"inner": "join", "left": "left join", "full": "full outer join"}
    if how in ("semi", "anti"):
        sql = f"select id, k_big, y from facts where {'' if how == 'semi' else 'not '}exists (select 1 from dims where k = k_big)"
    elif how == "full":
        sql = "select id, k_big, y, k, label, weight from facts full outer join dims on k_big = k"
    else:
        sql = f"select id, k_big, y, label, weight from facts {sqljoin[how]} dims on k_big = k"
    check_frame(out, duck, sql)


def test_api_join_same_names_suffix(tables):
    a = wh.from_dict({"k": [1, 2, 3], "v": [10, 20, 30]}).lazy()
    b = wh.from_dict({"k": [2, 3, 4], "v": [200, 300, 400]}).lazy()
    out = a.join(b, on="k").sort("k").collect()
    assert out.columns == ["k", "v", "v_right"]
    assert out.rows() == [(2, 20, 200), (3, 30, 300)]


def test_api_multikey_join(duck):
    rng = np.random.default_rng(7)
    n = 50_000
    a = pa.table({"a": rng.integers(0, 100, n), "b": rng.integers(0, 50, n), "v": rng.random(n)})
    b = pa.table({"a": rng.integers(0, 100, 3000), "b": rng.integers(0, 50, 3000), "w": rng.random(3000)})
    con = duckdb.connect()
    con.register("a", a)
    con.register("b", b)
    out = wh.from_arrow(a).lazy().join(wh.from_arrow(b).lazy(), on=["a", "b"])
    check_frame(out, con, "select a.a, a.b, v, w from a join b using (a, b)")


def test_api_string_join_keys(duck):
    a = pa.table({"s": ["x", "y", None, "z", "x"], "v": [1, 2, 3, 4, 5]})
    b = pa.table({"s": ["x", "z", None], "w": [10, 30, 99]})
    con = duckdb.connect()
    con.register("a", a)
    con.register("b", b)
    out = wh.from_arrow(a).lazy().join(wh.from_arrow(b).lazy(), on="s")
    check_frame(out, con, "select a.s, v, w from a join b on a.s = b.s")


def test_api_sort_limit(tables):
    df = wh.from_arrow(tables["facts"])
    out = df.lazy().sort("y", "id", descending=[True, False]).limit(20).collect().to_pandas()
    exp = tables["facts"].to_pandas().sort_values(["y", "id"], ascending=[False, True]).head(20)
    assert out["id"].tolist() == exp["id"].tolist()


def test_api_sort_nulls(tables):
    df = wh.from_arrow(tables["facts"]).select("id", "x")
    first = df.sort("x", nulls_last=False).head(3).to_pandas()
    last = df.sort("x", nulls_last=True).head(3).to_pandas()
    assert first["x"].isna().all()
    assert not last["x"].isna().any()


def test_api_when_then(tables, duck):
    lf = wh.from_arrow(tables["facts"]).lazy()
    out = lf.select(
        "id",
        F.when(F.col("y") > 500).then(F.lit("hi")).when(F.col("y") < -500).then(F.lit("lo")).otherwise(F.lit("mid")).alias("b"),
    )
    check_frame(out, duck, "select id, case when y > 500 then 'hi' when y < -500 then 'lo' else 'mid' end b from facts")


def test_api_str_dt_namespaces(tables, duck):
    lf = wh.from_arrow(tables["facts"]).lazy()
    out = lf.filter(F.col("cat").str.starts_with("e")).select(
        "id",
        F.col("cat").str.to_uppercase().alias("u"),
        F.col("cat").str.len_chars().alias("n"),
        F.col("d").dt.month().alias("m"),
    )
    check_frame(out, duck, "select id, upper(cat) u, length(cat) n, month(d) m from facts where starts_with(cat, 'e')")


def test_api_literal_types(tables, duck):
    lf = wh.from_arrow(tables["facts"]).lazy()
    out = lf.filter(F.col("d") >= dt.date(2022, 3, 1)).select("id")
    check_frame(out, duck, "select id from facts where d >= date '2022-03-01'")


def test_api_unique_union_drop_rename(tables):
    lf = wh.from_arrow(tables["small"]).lazy()
    u = lf.union(lf).unique().collect()
    assert u.height == 6
    r = lf.rename({"name": "nm"}).drop("k_small").collect()
    assert r.columns == ["nm"]


def test_sql_on_lazyframe(tables, duck):
    lf = wh.from_arrow(tables["facts"]).lazy().filter(F.col("flag"))
    out = lf.sql("select cat, count(*) c from self group by cat")
    check_frame(out, duck, "select cat, count(*) c from facts where flag group by cat")


def test_wh_sql_kwargs(tables, duck):
    out = wh.sql("select s.name, count(*) c from f join s on f.k_small = s.k_small group by s.name", f=tables["facts"], s=tables["small"])
    check_frame(out, duck, "select s.name, count(*) c from facts f join small s on f.k_small = s.k_small group by s.name")


# ---------------------------------------------------------------------------
# I/O & interop
# ---------------------------------------------------------------------------


def test_parquet_roundtrip_and_pruning(tmp_path, tables, duck):
    path = str(tmp_path / "facts.parquet")
    pq.write_table(tables["facts"], path, row_group_size=10_000)
    lf = wh.scan_parquet(path)
    q = lf.filter(F.col("id") < 15_000).select("id", "x")
    plan = q.explain()
    assert "row_groups=2/20" in plan, plan
    check_frame(q, duck, "select id, x from facts where id < 15000")
    out = str(tmp_path / "out" / "o.parquet")
    q.collect().write_parquet(out)
    back = pq.read_table(out)
    assert back.num_rows == 15_000


def test_parquet_glob_directory(tmp_path, tables, duck):
    d = tmp_path / "ds"
    d.mkdir()
    t = tables["facts"]
    for i in range(4):
        pq.write_table(t.slice(i * 50_000, 50_000), str(d / f"part-{i}.parquet"))
    check_frame(wh.scan_parquet(str(d)).group_by("k_small").agg(F.len()), duck, "select k_small, count(*) len from facts group by 1")
    check_frame(wh.scan_parquet(str(d / "*.parquet")).select(F.col("y").sum()), duck, "select sum(y) y from facts")


def test_count_star_parquet_metadata_only(tmp_path, tables):
    path = str(tmp_path / "c.parquet")
    pq.write_table(tables["facts"], path)
    assert wh.sql(f"select count(*) from '{path}'").collect().item() == N


def test_csv(tmp_path, tables, duck):
    path = str(tmp_path / "f.csv")
    wh.from_arrow(tables["small"]).write_csv(path)
    out = wh.scan_csv(path).sort("k_small", "name").collect()
    assert out.to_pydict() == {"k_small": [0, 1, 2, 3, 3, 11], "name": ["zero", "one", "two", "three", "three-b", "eleven"]}
    # large csv, parallel byte-range scanning
    big = str(tmp_path / "big.csv")
    # note: the CSV reader (like arrow-csv) reads both empty and "" fields as NULL
    duck.execute(f"COPY (select id, k_big, y, nullif(cat, '') cat from facts) TO '{big}' (HEADER)")
    check_frame(wh.scan_csv(big).group_by("cat").agg(F.col("y").sum(), F.len()), duck, "select nullif(cat, '') cat, sum(y) y, count(*) len from facts group by 1")


def test_interop_pandas_polars(tables):
    import pandas as pd
    import polars as pl

    pdf = pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", None]})
    out = wh.from_pandas(pdf).filter(F.col("a") > 1)
    assert out.to_pandas()["a"].tolist() == [2, 3]
    plf = pl.DataFrame({"a": [5, 6], "s": ["p", "q"]})
    out2 = wh.from_polars(plf).select((F.col("a") * 2).alias("a2"), "s")
    assert out2.to_polars().to_dict(as_series=False) == {"a2": [10, 12], "s": ["p", "q"]}
    # polars frames (string_view arrays) can be queried directly
    agg = wh.sql("select s, sum(a) t from p group by s order by s", p=plf).collect()
    assert agg.rows() == [("p", 5), ("q", 6)]


def test_explain_shows_pushdown(tables):
    lf = wh.from_arrow(tables["facts"]).lazy()
    q = lf.select("id", "x", "y").filter(F.col("x") > 1).sort("y").limit(5)
    plan = q.explain()
    assert "TopK" in plan
    assert "pruning_filters" in plan


def test_errors(tables):
    lf = wh.from_arrow(tables["small"]).lazy()
    with pytest.raises(wh.WorkhouseError, match="not found"):
        lf.select("nope").collect()
    with pytest.raises(wh.WorkhouseError):
        wh.sql("select k_small, name from s group by k_small", s=tables["small"]).collect()
    with pytest.raises(TypeError):
        bool(F.col("a") > 1)
