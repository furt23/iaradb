"""List columns, list functions, list aggregates and UNNEST.

SQL is checked against DuckDB, the Python API against Polars. Needs the
extension rebuilt (the lists live in the Rust engine).
"""

from __future__ import annotations

import math
import os
import sys
import tempfile

import duckdb
import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import workhouse as wh
from workhouse import functions as F

sys.path.insert(0, os.path.dirname(__file__))
from compare import diff  # noqa: E402

I64 = pa.list_(pa.int64())
STR = pa.list_(pa.string())


@pytest.fixture(scope="module")
def table() -> pa.Table:
    return pa.table(
        {
            "id": pa.array(list(range(1, 11)), pa.int64()),
            "g": pa.array([1, 1, 1, 2, 2, 3, 3, 3, 4, 5], pa.int64()),
            "x": pa.array([3, 1, None, 5, 5, None, 7, 8, 9, 4], pa.int64()),
            "l": pa.array(
                [[1, 2, 3], None, [], [4, None], [5], [3, 3, 1], [None, None], [9, 8, 7, 6], [2], [0, 1]], I64
            ),
            "s": pa.array(
                [["a", "b"], ["é", None], None, [], ["x"], ["b", "a", "b"], ["ü", "ñ"], [""], ["z", "y"], ["m"]], STR
            ),
            "txt": ["a,b,,c", "é;ü", None, "", "x", "a1b22c", "l,m;n", "abc", ",", "q,r"],
        }
    )


def duck(table: pa.Table) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.register("t", table)
    return con


def check(table: pa.Table, query: str, duck_query: str | None = None, ordered: bool = True) -> None:
    ours = wh.sql(query, t=table).collect().to_arrow()
    exp = duck(table).execute(duck_query or query).arrow().read_all()
    d = diff(ours, exp, ordered=ordered)
    assert d is None, f"{query}: {d}"


# ---------------------------------------------------------------------------
# SQL functions against DuckDB
# ---------------------------------------------------------------------------

FUNCTIONS = [
    "len(l)",
    "array_length(l)",
    "list_contains(l, 2)",
    "list_contains(s, 'b')",
    "array_contains(l, 3)",
    "list_has(l, 5)",
    "list_position(l, 3)",
    "list_position(s, 'a')",
    "l[1]",
    "l[2]",
    "l[-1]",
    "l[0]",
    "s[1]",
    "list_extract(l, 3)",
    "l[2:3]",
    "l[:2]",
    "l[2:]",
    "l[-2:]",
    "list_slice(l, 1, 2)",
    "list_slice(l, -3, -1)",
    "list_slice(l, 0, 10)",
    "list_slice(l, 3, 2)",
    "list_sort(l)",
    "list_sort(l, 'DESC')",
    "list_sort(l, 'ASC', 'NULLS FIRST')",
    "list_sort(s)",
    "array_sort(s, 'DESC')",
    "list_reverse(l)",
    "list_reverse(s)",
    "list_distinct(l)",
    "list_distinct(s)",
    "list_unique(l)",
    "array_to_string(s, ',')",
    "array_to_string(l, '-')",
    "list_concat(l, [9, 10])",
    "list_concat(l, l)",
    "l || [9]",
    "[0] || l",
    "list_concat(s, ['z'])",
    "list_sum(l)",
    "list_min(l)",
    "list_max(l)",
    "list_avg(l)",
    "list_count(l)",
    "list_aggr(l, 'sum')",
    "list_aggr(l, 'max')",
    "list_max(s)",
    "list_min(s)",
    "string_split(txt, ',')",
    "string_split(txt, '')",
    "str_split(txt, ';')",
    "regexp_split_to_array(txt, '[,;]')",
    "regexp_split_to_array(txt, '[0-9]+')",
    "[id, id + 1, NULL]",
    "list_value(id, id * 2)",
    "['a', txt]",
    "[l, l]",
    "[]::int[]",
    "len(string_split(txt, ','))",
    "array_to_string(string_split(txt, ','), '|')",
    "list_sum(list_concat(l, [1]))",
    "l is null",
    "coalesce(l, [])",
    "case when len(l) > 1 then l else [0] end",
]


@pytest.mark.parametrize("expr", FUNCTIONS)
def test_function_matches_duckdb(table: pa.Table, expr: str) -> None:
    check(table, f"select id, {expr} as r from t order by id")


def test_list_columns_flow_through_operators(table: pa.Table) -> None:
    check(table, "select id, l, s from t where g >= 2 order by id")
    check(table, "select id, l from t order by x desc nulls last, id limit 4")
    check(table, "select id, l from t where id > 2 union all select id, l from t where id < 2 order by id")
    check(table, "select a.id, a.l, b.s from t a join t b on a.id = b.id + 1 order by a.id")
    check(table, "select a.id, b.l from t a left join t b on a.g = b.id order by a.id")
    check(table, "select g, count(l) as n, sum(len(l)) as m from t group by g order by g")


def test_lists_cannot_be_keys_yet(table: pa.Table) -> None:
    for query in [
        "select l, count(*) from t group by l",
        "select distinct l from t",
        "select * from t order by l",
        "select a.id from t a join t b on a.l = b.l",
    ]:
        with pytest.raises(wh.WorkhouseError, match="cannot be used as"):
            wh.sql(query, t=table).collect()


# ---------------------------------------------------------------------------
# aggregates
# ---------------------------------------------------------------------------


def test_array_agg_matches_duckdb(table: pa.Table) -> None:
    check(
        table,
        "select g, array_agg(x) as a, list(l) as ls, array_agg(txt) as ts from t group by g order by g",
        "select g, array_agg(x order by id) as a, list(l order by id) as ls, array_agg(txt order by id) as ts "
        "from t group by g order by g",
    )
    check(table, "select array_agg(x) as a, array_agg(s) as b from t", "select array_agg(x order by id) as a, array_agg(s order by id) as b from t")
    check(table, "select array_agg(x) as a from t where id > 100", "select array_agg(x order by id) as a from t where id > 100")


def test_array_agg_order_by_and_filter(table: pa.Table) -> None:
    check(table, "select g, array_agg(id order by x desc, id) as a from t group by g order by g")
    check(table, "select g, list(x order by x nulls first) as a from t group by g order by g")
    check(
        table,
        "select g, array_agg(x) filter (where id % 2 = 0) as a from t group by g order by g",
        "select g, array_agg(x order by id) filter (where id % 2 = 0) as a from t group by g order by g",
    )
    check(table, "select array_agg(distinct g order by g) as a from t")


def test_collect_list_and_set(table: pa.Table) -> None:
    check(
        table,
        "select g, collect_list(x) as a from t group by g order by g",
        "select g, coalesce(list(x order by id) filter (where x is not null), []) as a from t group by g order by g",
    )
    check(
        table,
        "select g, list_sort(collect_set(x)) as a from t group by g order by g",
        "select g, coalesce(list_sort(list(distinct x) filter (where x is not null)), []) as a from t group by g order by g",
    )
    check(
        table,
        "select list_sort(array_agg(distinct x)) as a from t",
        "select list_sort(array_agg(distinct x)) as a from t",
    )


def test_list_aggregates_with_other_aggregates(table: pa.Table) -> None:
    check(
        table,
        "select g, sum(x) as s, array_agg(id order by id) as ids, count(*) as n from t group by g order by g",
    )
    check(table, "select list_sum(array_agg(x)) as s, len(array_agg(x)) as n from t", "select sum(x) as s, count(*) as n from t")


def test_array_agg_in_a_window_is_rejected(table: pa.Table) -> None:
    with pytest.raises(wh.WorkhouseError, match="array_agg"):
        wh.sql("select array_agg(x) over (partition by g) from t", t=table).collect()


# ---------------------------------------------------------------------------
# unnest
# ---------------------------------------------------------------------------


def test_unnest_matches_duckdb(table: pa.Table) -> None:
    check(table, "select id, unnest(l) as e from t order by id, e")
    check(table, "select id, unnest(s) as e from t order by id, e")
    check(table, "select unnest(l) as e from t order by e")
    check(table, "select id, unnest(l) + 1 as e from t order by id, e")
    check(table, "select id, unnest(l) as a, unnest(s) as b from t order by id, a, b")
    check(table, "select t.id, u.x from t, unnest(t.l) as u(x) order by t.id, u.x")
    check(table, "select t.id, u.e from t cross join unnest(t.s) as u(e) where u.e is not null order by 1, 2")
    check(table, "select sum(e), count(*) from (select unnest(l) as e from t)")
    check(table, "select g, count(*) as n from t, unnest(t.l) as u(e) group by g order by g")
    check(table, "select * from unnest([10, 20, 30]) as u(v)")


# ---------------------------------------------------------------------------
# Python API against Polars
# ---------------------------------------------------------------------------


def values(df) -> list:
    t = df.to_arrow()
    return [[_norm(v) for v in t.column(i).to_pylist()] for i in range(t.num_columns)]


def _norm(v):
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, list):
        return [_norm(x) for x in v]
    return v


def both(table: pa.Table, wh_expr, pl_expr, sort_lists: bool = False) -> None:
    ours = values(wh.from_arrow(table).lazy().select(wh_expr.alias("r")).collect())
    theirs = values(pl.from_arrow(table).select(pl_expr.alias("r")))
    if sort_lists:
        key = lambda v: (v is None, v)  # noqa: E731
        ours = [[None if v is None else sorted(v, key=key) for v in c] for c in ours]
        theirs = [[None if v is None else sorted(v, key=key) for v in c] for c in theirs]
    assert ours == theirs


L = F.col("l")
PL = pl.col("l")


def test_list_namespace_matches_polars(table: pa.Table) -> None:
    both(table, L.list.len(), PL.list.len())
    both(table, L.list.get(0), PL.list.get(0, null_on_oob=True))
    both(table, L.list.get(1), PL.list.get(1, null_on_oob=True))
    both(table, L.list.get(-1), PL.list.get(-1, null_on_oob=True))
    both(table, L.list.get(-2), PL.list.get(-2, null_on_oob=True))
    both(table, L.list.first(), PL.list.first())
    both(table, L.list.last(), PL.list.last())
    both(table, L.list.contains(3), PL.list.contains(3))
    both(table, L.list.sort(), PL.list.sort())
    both(table, L.list.sort(descending=True), PL.list.sort(descending=True))
    both(table, L.list.sort(nulls_last=True), PL.list.sort(nulls_last=True))
    both(table, L.list.reverse(), PL.list.reverse())
    both(table, L.list.unique(), PL.list.unique(), sort_lists=True)
    both(table, L.list.n_unique(), PL.list.n_unique())
    both(table, L.list.slice(1), PL.list.slice(1))
    both(table, L.list.slice(1, 2), PL.list.slice(1, 2))
    both(table, L.list.slice(-2, 1), PL.list.slice(-2, 1))
    both(table, L.list.slice(-3), PL.list.slice(-3))
    both(table, L.list.slice(0, 0), PL.list.slice(0, 0))
    both(table, L.list.head(2), PL.list.head(2))
    both(table, L.list.tail(2), PL.list.tail(2))
    both(table, L.list.sum(), PL.list.sum())
    both(table, L.list.min(), PL.list.min())
    both(table, L.list.max(), PL.list.max())
    both(table, L.list.mean(), PL.list.mean())


def test_list_join_and_str_split_match_polars(table: pa.Table) -> None:
    S = F.col("s")
    both(table, S.list.join(","), pl.col("s").list.join(","))
    both(table, S.list.join(", ", ignore_nulls=False), pl.col("s").list.join(", ", ignore_nulls=False))
    both(table, F.col("txt").str.split(","), pl.col("txt").str.split(","))
    both(table, F.col("txt").str.split(";").list.len(), pl.col("txt").str.split(";").list.len())


def test_concat_list_matches_polars(table: pa.Table) -> None:
    both(table, F.concat_list("l", "l"), pl.concat_list("l", "l"))
    both(table, F.concat_list("l", F.col("x")), pl.concat_list("l", "x"))
    both(table, F.concat_list("x", "id"), pl.concat_list("x", "id"))


def test_implode_and_group_by_agg_list(table: pa.Table) -> None:
    ours = (
        wh.from_arrow(table).lazy().group_by("g").agg(F.col("x").implode().alias("xs"), F.col("l").implode().alias("ls")).sort("g").collect()
    )
    theirs = pl.from_arrow(table).group_by("g").agg(pl.col("x").alias("xs"), pl.col("l").alias("ls")).sort("g")
    assert values(ours) == values(theirs)
    whole = wh.from_arrow(table).lazy().select(F.col("x").implode().alias("xs")).collect().to_arrow().to_pylist()
    assert whole == [{"xs": table.column("x").to_pylist()}]
    # filtered
    f = wh.from_arrow(table).lazy().group_by("g").agg(F.col("x").filter(F.col("id") > 3).implode().alias("xs")).sort("g").collect()
    p = pl.from_arrow(table).group_by("g").agg(pl.col("x").filter(pl.col("id") > 3).alias("xs")).sort("g")
    assert values(f) == values(p)


def test_explode_matches_polars(table: pa.Table) -> None:
    ours = wh.from_arrow(table).lazy().select("id", "l").explode("l").collect()
    theirs = pl.from_arrow(table).select("id", "l").explode("l")
    assert values(ours) == values(theirs)
    ours = wh.from_arrow(table).lazy().select("id", "s", "l").explode("s").collect()
    theirs = pl.from_arrow(table).select("id", "s", "l").explode("s")
    assert values(ours) == values(theirs)
    # in place: column order and names are kept
    assert ours.to_arrow().column_names == ["id", "s", "l"]


# ---------------------------------------------------------------------------
# interop and types
# ---------------------------------------------------------------------------


def test_schema_names_and_arrow_types(table: pa.Table) -> None:
    lf = wh.from_arrow(table).lazy()
    assert lf.schema["l"] == "List<Int64>"
    assert lf.schema["s"] == "List<Utf8>"
    out = lf.select(F.col("l").list.len().alias("n"), F.col("s")).collect().to_arrow()
    assert out.schema.field("s").type == pa.list_(pa.string())
    nested = wh.sql("select [[1, 2], [3]] as ll").collect()
    assert nested.to_arrow().schema.field("ll").type == pa.list_(pa.list_(pa.int64()))
    assert wh.sql("select [[1, 2], [3]] as ll").schema["ll"] == "List<List<Int64>>"


def test_pyarrow_and_polars_round_trip(table: pa.Table) -> None:
    df = wh.from_arrow(table).lazy().select("id", "l", "s").collect()
    assert df.to_arrow().to_pylist() == table.select(["id", "l", "s"]).to_pylist()
    back = pl.from_arrow(df.to_arrow())
    assert back.schema["l"] == pl.List(pl.Int64)
    assert back["s"].to_list() == table.column("s").to_pylist()
    assert wh.from_polars(pl.from_arrow(table)).lazy().collect().to_arrow().to_pylist() == table.to_pylist()


def test_large_list_and_other_element_names_are_normalized() -> None:
    t = pa.table({"a": pa.array([[1, 2], None, [3]], pa.large_list(pa.int64())), "b": pa.array([["x"], [], None], pa.list_(pa.field("element", pa.string())))})
    df = wh.from_arrow(t).lazy().collect().to_arrow()
    assert df.schema.field("a").type == pa.list_(pa.int64())
    assert df.to_pylist() == t.to_pylist()
    assert wh.from_arrow(t).lazy().select(F.col("a").list.sum()).collect().to_arrow().column(0).to_pylist() == [3, None, 3]


def test_parquet_nested_columns_round_trip(table: pa.Table) -> None:
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "n.parquet")
        pq.write_table(table, path)  # pyarrow names list elements "element"
        lf = wh.scan_parquet(path)
        assert lf.schema["l"] == "List<Int64>"
        got = lf.sort("id").collect().to_arrow()
        assert got.to_pylist() == table.to_pylist()
        n = lf.filter(F.col("g") >= 3).select(F.col("l").list.len().alias("n"), "id").sort("id").collect().to_arrow()
        expected = [len(v) if v is not None else None for v in table.column("l").to_pylist()][5:]
        assert n.column("n").to_pylist() == expected
        out = os.path.join(d, "o.parquet")
        wh.read_parquet(path).write_parquet(out)
        assert pq.read_table(out).sort_by("id").to_pylist() == table.to_pylist()
        assert pl.read_parquet(out).sort("id")["l"].to_list() == table.column("l").to_pylist()


def test_nested_lists_work(table: pa.Table) -> None:
    check(table, "select id, [l, l] as ll, len([l, l]) as n, ([l, l])[2] as second from t order by id")
    check(table, "select g, array_agg(l order by id) as ls from t group by g order by g")
    check(table, "select id, unnest([l, l]) as e from t where id < 3 order by id")


# ---------------------------------------------------------------------------
# large groups, with and without a memory limit
# ---------------------------------------------------------------------------


def test_large_groups_and_spill_match_duckdb() -> None:
    n = 600_000
    ids = pa.array(range(n), pa.int64())
    t = pa.table({"id": ids, "k": pa.array([i % 150_000 for i in range(n)], pa.int64()), "few": pa.array([i % 7 for i in range(n)], pa.int64())})
    queries = [
        ("select k, list_sort(array_agg(id)) a from t group by k order by k", None),
        ("select few, len(array_agg(id)) n, list_sum(array_agg(id)) s, list_unique(array_agg(k)) u from t group by few order by few", None),
        ("select few, list_slice(array_agg(id order by id desc), 1, 3) head3 from t group by few order by few", None),
    ]
    expected = [duck(t).execute(d or q).arrow().read_all() for q, d in queries]
    for limit in (None, "24MB"):
        if limit:
            wh.set_memory_limit(limit)
        try:
            for (q, _), exp in zip(queries, expected):
                d = diff(wh.sql(q, t=t).collect().to_arrow(), exp)
                assert d is None, f"{q} (limit {limit}): {d}"
        finally:
            if limit:
                wh.set_memory_limit(None)
