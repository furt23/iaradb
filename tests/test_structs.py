"""Struct columns, nested JSON and the JSON text functions.

SQL is checked against DuckDB, the Python API against Polars. Needs the
extension rebuilt (structs live in the Rust engine).
"""

from __future__ import annotations

import json
import math
import os
import sys

import duckdb
import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import workhouse as wh

sys.path.insert(0, os.path.dirname(__file__))
from compare import diff  # noqa: E402

S_TYPE = pa.struct([("a", pa.int64()), ("b", pa.string())])
N_TYPE = pa.struct([("x", pa.int64()), ("l", pa.list_(pa.string()))])
E_TYPE = pa.list_(pa.struct([("k", pa.string()), ("v", pa.int64())]))
D_TYPE = pa.struct([("p", pa.struct([("q", pa.int64()), ("r", pa.string())])), ("z", pa.float64())])


@pytest.fixture(scope="module")
def table() -> pa.Table:
    return pa.table(
        {
            "id": pa.array(list(range(1, 9)), pa.int64()),
            "g": pa.array([1, 1, 2, 2, 2, 3, 3, 4], pa.int64()),
            "s": pa.array(
                [{"a": 1, "b": "x"}, None, {"a": None, "b": "z"}, {"a": 4, "b": None}, {"a": 5, "b": "é"}, {"a": 6, "b": "q"}, None, {"a": 8, "b": ""}],
                S_TYPE,
            ),
            "n": pa.array(
                [{"x": 1, "l": ["p", "q"]}, {"x": 2, "l": []}, None, {"x": None, "l": None}, {"x": 5, "l": ["r", None]}, {"x": 6, "l": ["s"]}, {"x": 7, "l": ["t", "u"]}, {"x": 8, "l": []}],
                N_TYPE,
            ),
            "ls": pa.array(
                [[{"k": "a", "v": 1}, {"k": "b", "v": None}], None, [], [None, {"k": None, "v": 4}], [{"k": "e", "v": 5}], [{"k": "f", "v": 6}], [], [{"k": "h", "v": 8}]],
                E_TYPE,
            ),
            "d": pa.array(
                [{"p": {"q": 1, "r": "u"}, "z": 1.5}, {"p": None, "z": 2.5}, None, {"p": {"q": None, "r": "w"}, "z": None}, {"p": {"q": 5, "r": None}, "z": 5.5}, None, {"p": {"q": 7, "r": "y"}, "z": 7.5}, {"p": {"q": 8, "r": ""}, "z": 8.5}],
                D_TYPE,
            ),
            "txt": ["a", "bb", None, "", "é", "f", "g", "h"],
        }
    )


def duck(table: pa.Table) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.register("t", table)
    return con


def check(table: pa.Table, query: str, duck_query: str | None = None) -> None:
    ours = wh.sql(query, t=table).collect().to_arrow()
    exp = duck(table).execute(duck_query or query).arrow().read_all()
    d = diff(ours, exp, ordered=True)
    assert d is None, f"{query}: {d}"


# ---------------------------------------------------------------------------
# SQL against DuckDB
# ---------------------------------------------------------------------------

EXPRESSIONS = [
    "s",
    "n",
    "ls",
    "d",
    "s.a",
    "s.b",
    "s['a']",
    "struct_extract(s, 'b')",
    "t.s.a",
    "(s).b",
    "n.x",
    "n.l",
    "n.l[1]",
    "len(n.l)",
    "ls[1].k",
    "ls[2].v",
    "ls[-1]",
    "d.p",
    "d.p.q",
    "d.p.r",
    "d.z",
    "s.a + 1",
    "s.a * n.x",
    "s.b || 'x'",
    "s.a is null",
    "s is null",
    "n.l is null",
    "{'a': id, 'b': txt}",
    "{'a': id, 'b': {'c': [id, id + 1]}}",
    "struct_pack(a := id, b := id * 2)",
    "struct_pack(x := s, y := txt)",
    "struct_insert(s, c := id)",
    "struct_insert(d, extra := txt).extra",
    "[{'x': id}, {'x': id + 1}]",
    "[{'x': id}, NULL]",
    "s = {'a': 1, 'b': 'x'}",
    "s <> {'a': 1, 'b': 'x'}",
    "s = s",
    "s < {'a': 5, 'b': 'e'}",
    "{'a': id} = {'a': 3}",
    "coalesce(s, {'a': 0, 'b': '-'})",
    "case when id > 4 then s end",
    "case when id > 4 then s else {'a': -1, 'b': '='} end",
    "if(id % 2 = 0, s, {'a': 0, 'b': 'odd'})",
    "ls[1] = {'k': 'a', 'v': 1}",
    "s in ({'a': 1, 'b': 'x'}, {'a': 4, 'b': NULL})",
    "s::STRUCT(a DOUBLE, b VARCHAR)",
    "cast(n as STRUCT(x BIGINT, l VARCHAR[]))",
]


@pytest.mark.parametrize("expr", EXPRESSIONS)
def test_expression_matches_duckdb(table: pa.Table, expr: str) -> None:
    check(table, f"select id, {expr} as r from t order by id")


def test_struct_columns_flow_through_operators(table: pa.Table) -> None:
    check(table, "select id, s, n, ls, d from t where g >= 2 order by id")
    check(table, "select id, s from t order by g desc, id limit 4")
    check(table, "select id, s, d from t where id > 5 union all select id, s, d from t where id < 3 order by id")
    check(table, "select a.id, a.s, b.d from t a join t b on a.id = b.id + 1 order by a.id")
    check(table, "select a.id, b.n from t a left join t b on a.g = b.id order by a.id")
    check(table, "select g, count(s) as c, count(s.a) as ca from t group by g order by g")
    check(table, "select id, s, row_number() over (partition by g order by id) as rn from t order by id")
    check(table, "select id, s from t where s.a > 1 order by id")
    check(table, "select id, s.b from t where n.x is not null and d.p.q > 0 order by id")


def test_structs_cannot_be_keys_yet(table: pa.Table) -> None:
    for query in [
        "select s, count(*) from t group by s",
        "select distinct s from t",
        "select * from t order by s",
        "select a.id from t a join t b on a.s = b.s",
        "select id, row_number() over (partition by s order by id) from t",
    ]:
        with pytest.raises(wh.WorkhouseError, match="cannot be used as"):
            wh.sql(query, t=table).collect()


def test_field_errors_list_the_fields(table: pa.Table) -> None:
    with pytest.raises(wh.WorkhouseError, match="no field 'zz'.*fields: a, b"):
        wh.sql("select s.zz from t", t=table).collect()
    with pytest.raises(wh.WorkhouseError, match="not a struct"):
        wh.sql("select id.a from t", t=table).collect()


# ---------------------------------------------------------------------------
# unnest and star
# ---------------------------------------------------------------------------


def test_unnest_and_star_match_duckdb(table: pa.Table) -> None:
    check(table, "select unnest(s) from t order by id", "select unnest(s) from t order by id")
    check(table, "select id, unnest(s) from t order by id")
    check(table, "select id, unnest(d.p) from t order by id")
    check(table, "select s.* from t order by id")
    check(table, "select id, n.* from t order by id")
    check(table, "select id, e.k, e.v from (select id, unnest(ls) as e from t) order by id, e.k")
    check(table, "select sum(e.v), count(e.k) from (select unnest(ls) as e from t)")
    check(table, "select * from (select unnest({'a': 1, 'b': 2}))")


# ---------------------------------------------------------------------------
# aggregates
# ---------------------------------------------------------------------------


def test_aggregates_over_structs_match_duckdb(table: pa.Table) -> None:
    check(
        table,
        "select g, array_agg(s) as a, array_agg(ls) as b from t group by g order by g",
        "select g, array_agg(s order by id) as a, array_agg(ls order by id) as b from t group by g order by g",
    )
    check(table, "select array_agg(d) as a from t", "select array_agg(d order by id) as a from t")
    check(table, "select g, min(s) as lo, max(s) as hi from t group by g order by g")
    check(table, "select min(d) as lo, max(d) as hi, min(ls) as ml, max(ls) as xl from t")
    check(table, "select g, max_by(s, id) as m, min_by(d, id) as n from t group by g order by g")
    check(table, "select count(distinct s) as n from t")


# ---------------------------------------------------------------------------
# Parquet written by pyarrow
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def parquet_file(table: pa.Table, tmp_path_factory: pytest.TempPathFactory) -> str:
    path = str(tmp_path_factory.mktemp("structs") / "t.parquet")
    pq.write_table(table, path, row_group_size=3)
    return path


def test_parquet_nested_columns_round_trip(table: pa.Table, parquet_file: str) -> None:
    got = wh.scan_parquet(parquet_file).sort("id").collect().to_arrow()
    assert got.to_pylist() == table.to_pylist()
    # a projection of a few fields, and pushdown on a flat column
    r = wh.scan_parquet(parquet_file).filter(wh.col("id") > 4).select("id", wh.col("d").struct.field("p")).sort("id").collect()
    assert r.to_arrow().column("p").to_pylist() == [v["p"] if v else None for v in table.column("d").to_pylist()][4:]


def test_parquet_queries_match_duckdb(table: pa.Table, parquet_file: str) -> None:
    con = duckdb.connect()
    for q in [
        "select id, s.a, n.l[1], ls[1].k, d.p.q from t order by id",
        "select g, array_agg(s order by id) as a from t group by g order by g",
        "select id, unnest(s) from t order by id",
    ]:
        ours = wh.sql(q, t=wh.scan_parquet(parquet_file)).collect().to_arrow()
        exp = con.execute(q.replace(" t ", f" read_parquet('{parquet_file.replace(chr(92), '/')}') ")).arrow().read_all()
        assert diff(ours, exp) is None, q


def test_write_parquet_and_back(table: pa.Table, tmp_path) -> None:
    path = str(tmp_path / "out.parquet")
    wh.from_arrow(table).write_parquet(path)
    assert pq.read_table(path).to_pylist() == table.to_pylist()
    assert pq.read_table(path).schema.field("s").type == S_TYPE


# ---------------------------------------------------------------------------
# the Python API against Polars
# ---------------------------------------------------------------------------


def _norm(v):
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, list):
        return [_norm(x) for x in v]
    if isinstance(v, dict):
        return {k: _norm(x) for k, x in v.items()}
    return v


def values(df) -> list:
    t = df.to_arrow()
    return [[_norm(v) for v in t.column(i).to_pylist()] for i in range(t.num_columns)]


def both(table: pa.Table, wh_expr, pl_expr) -> None:
    ours = values(wh.from_arrow(table).lazy().select(wh_expr.alias("r")).collect())
    theirs = values(pl.from_arrow(table).select(pl_expr.alias("r")))
    assert ours == theirs


def test_arrow_round_trip_keeps_struct_types(table: pa.Table) -> None:
    out = wh.from_arrow(table).to_arrow()
    assert out.to_pylist() == table.to_pylist()
    assert out.schema.field("s").type == S_TYPE
    assert out.schema.field("ls").type == E_TYPE
    assert out.schema.field("d").type == D_TYPE
    assert wh.from_polars(pl.from_arrow(table)).to_arrow().to_pylist() == table.to_pylist()
    assert wh.from_dict({"s": [{"a": 1}, None, {"a": 3}]}).to_arrow().to_pylist() == [{"s": {"a": 1}}, {"s": None}, {"s": {"a": 3}}]
    assert wh.from_arrow(table).schema["s"] == "Struct<a: Int64, b: Utf8>"
    assert wh.from_arrow(table).schema["ls"] == "List<Struct<k: Utf8, v: Int64>>"


def test_struct_namespace_matches_polars(table: pa.Table) -> None:
    both(table, wh.col("s").struct.field("a"), pl.col("s").struct.field("a"))
    both(table, wh.col("s").struct.field("b"), pl.col("s").struct.field("b"))
    both(table, wh.col("d").struct.field("p").struct.field("r"), pl.col("d").struct.field("p").struct.field("r"))
    both(table, wh.col("s").struct.rename_fields(["x", "y"]), pl.col("s").struct.rename_fields(["x", "y"]))
    both(table, wh.col("s").struct.json_encode(), pl.col("s").struct.json_encode())
    both(table, wh.col("d").struct.json_encode(), pl.col("d").struct.json_encode())
    both(table, wh.col("n").struct.field("l").list.len(), pl.col("n").struct.field("l").list.len())


def test_struct_builder_matches_polars(table: pa.Table) -> None:
    both(table, wh.struct("id", "txt"), pl.struct("id", "txt"))
    both(table, wh.struct(wh.col("id").alias("k"), wh.col("g") + 1), pl.struct(pl.col("id").alias("k"), pl.col("g") + 1))
    both(table, wh.struct(total=wh.col("id") + wh.col("g")), pl.struct(total=pl.col("id") + pl.col("g")))
    both(table, wh.struct("s", "n"), pl.struct("s", "n"))
    with pytest.raises(ValueError, match="twice"):
        wh.struct(wh.col("id"), wh.col("id"))
    # a dict is a struct literal
    out = wh.from_arrow(table).lazy().select("id", wh.lit(1).alias("one")).with_columns(c={"a": 1, "b": "x"}).collect().to_arrow()
    assert out.column("c").to_pylist() == [{"a": 1, "b": "x"}] * 8


def test_unnest_matches_polars(table: pa.Table) -> None:
    ours = wh.from_arrow(table).lazy().select("id", "s", "d").unnest("s").collect()
    theirs = pl.from_arrow(table).select("id", "s", "d").unnest("s")
    assert values(ours) == values(theirs)
    assert ours.to_arrow().column_names == ["id", "a", "b", "d"]
    ours = wh.from_arrow(table).lazy().select("id", "s", "n").unnest("s", "n", separator="_").collect()
    theirs = pl.from_arrow(table).select("id", "s", "n").unnest("s", "n", separator="_")
    assert ours.to_arrow().column_names == theirs.columns
    assert values(ours) == values(theirs)
    # inside select: one column per field
    ours = wh.from_arrow(table).lazy().select("id", wh.col("s").struct.unnest()).collect()
    theirs = pl.from_arrow(table).select("id", pl.col("s").struct.unnest())
    assert values(ours) == values(theirs)
    # eager frames
    assert wh.from_arrow(table).unnest("d").to_arrow().column_names[:3] == ["id", "g", "s"]
    with pytest.raises(wh.WorkhouseError, match="not a struct"):
        wh.from_arrow(table).unnest("id")
    with pytest.raises(wh.WorkhouseError, match="twice"):
        wh.from_arrow(table).lazy().select(wh.col("g").alias("a"), "s").unnest("s").collect()


def test_explode_then_unnest_a_list_of_structs(table: pa.Table) -> None:
    ours = wh.from_arrow(table).lazy().select("id", "ls").explode("ls").unnest("ls").collect()
    theirs = pl.from_arrow(table).select("id", "ls").explode("ls").unnest("ls")
    assert values(ours) == values(theirs)


def test_group_by_agg_keeps_struct_payloads(table: pa.Table) -> None:
    ours = wh.from_arrow(table).lazy().group_by("g").agg(wh.col("s").implode().alias("ss"), wh.col("id").max().alias("m")).sort("g").collect()
    theirs = pl.from_arrow(table).group_by("g").agg(pl.col("s").alias("ss"), pl.col("id").max().alias("m")).sort("g")
    assert values(ours) == values(theirs)
    # first / last skip null structs (the engine's first / last); the payload is carried whole
    ours = wh.from_arrow(table).lazy().group_by("g").agg(wh.col("s").first().alias("f"), wh.col("s").last().alias("l")).sort("g").collect()
    assert ours.to_arrow().column("f").to_pylist() == [{"a": 1, "b": "x"}, {"a": None, "b": "z"}, {"a": 6, "b": "q"}, {"a": 8, "b": ""}]
    assert ours.to_arrow().column("l").to_pylist() == [{"a": 1, "b": "x"}, {"a": 5, "b": "é"}, {"a": 6, "b": "q"}, {"a": 8, "b": ""}]


# ---------------------------------------------------------------------------
# JSON text
# ---------------------------------------------------------------------------

DOCS = [
    '{"a": {"b": [1, 2, {"c": "x"}]}, "n": null, "s": "x y", "t": true, "f": 1.5}',
    '{"a": {"b": []}, "n": 5, "s": "é", "t": false, "f": -2}',
    '{"a": null, "s": null}',
    None,
    "{}",
]


@pytest.fixture(scope="module")
def jt() -> pa.Table:
    return pa.table({"id": list(range(len(DOCS))), "j": DOCS})


def check_json(jt: pa.Table, query: str, duck_query: str | None = None) -> None:
    ours = wh.sql(query, t=jt).collect().to_arrow()
    con = duckdb.connect()
    con.register("t", jt)
    exp = con.execute(duck_query or query).arrow().read_all()
    d = diff(ours, exp, ordered=True)
    assert d is None, f"{query}: {d}"


JSON_FUNCTIONS = [
    "json_extract_string(j, '$.s')",
    "json_extract_string(j, '$.a.b[2].c')",
    "json_extract_string(j, '$.a.b[0]')",
    "json_extract_string(j, '$.a.b[#-1]')",
    "json_extract_string(j, '$.t')",
    "json_extract_string(j, '$.n')",
    "json_extract_string(j, 'n')",
    "json_extract_string(j, '$.nope')",
    "json_extract(j, '$.a.b')",
    "json_extract(j, '$.s')",
    "json_extract(j, '$.n')",
    "json_extract(j, '$.t')",
    "json_extract(j, '$.a.b[2]')",
    "j ->> '$.s'",
    "j ->> 's'",
    "j -> 's'",
    "j -> 'a' -> 'b'",
    "j -> '$.a.b' ->> 1",
    "json_array_length(j, '$.a.b')",
    "json_array_length(j, '$.nope')",
    "json_array_length(j)",
    "cast(j ->> '$.f' as double)",
]


@pytest.mark.parametrize("expr", JSON_FUNCTIONS)
def test_json_function_matches_duckdb(jt: pa.Table, expr: str) -> None:
    valid = "where j is not null"
    check_json(jt, f"select id, {expr} as r from t {valid} order by id")


def test_json_null_input_gives_null(jt: pa.Table) -> None:
    out = wh.sql("select json_extract_string(j, '$.s') as r, json_array_length(j) as n, j -> 'a' as e from t where id = 3", t=jt).collect().to_arrow()
    assert out.to_pylist() == [{"r": None, "n": None, "e": None}]


def test_to_json_matches_duckdb(table: pa.Table) -> None:
    for expr in ["to_json(s)", "to_json(n)", "to_json(ls)", "to_json(d)", "to_json(id)", "to_json(txt)", "to_json([id, id + 1])"]:
        ours = wh.sql(f"select id, {expr} as r from t order by id", t=table).collect().to_arrow()
        exp = duck(table).execute(f"select id, {expr}::VARCHAR as r from t order by id").arrow().read_all()
        # DuckDB prints floats like 1.5 and the same compact JSON
        assert diff(ours, exp) is None, expr


def test_json_decode_and_path_match_match_polars(jt: pa.Table) -> None:
    dtype_wh = wh.Struct({"a": wh.Struct({"b": wh.List("float64")}), "s": "utf8", "t": "bool"})
    dtype_pl = pl.Struct({"a": pl.Struct({"b": pl.List(pl.Float64)}), "s": pl.String, "t": pl.Boolean})
    docs = [d for d in DOCS if d is not None and "{" in d and '"c"' not in d]
    t = pa.table({"j": docs})
    ours = wh.from_arrow(t).lazy().select(wh.col("j").str.json_decode(dtype_wh).alias("r")).collect().to_arrow().column("r").to_pylist()
    theirs = pl.from_arrow(t).select(pl.col("j").str.json_decode(dtype_pl).alias("r"))["r"].to_list()
    assert ours == theirs
    both(jt, wh.col("j").str.json_path_match("$.s"), pl.col("j").str.json_path_match("$.s"))
    both(jt, wh.col("j").str.json_path_match("$.t"), pl.col("j").str.json_path_match("$.t"))
    both(jt, wh.col("j").str.json_path_match("$.a.b[0]"), pl.col("j").str.json_path_match("$.a.b[0]"))
    with pytest.raises(TypeError, match="dtype"):
        wh.col("j").str.json_decode()


def test_json_round_trip_with_struct_dtype(table: pa.Table) -> None:
    dtype = wh.Struct({"a": "int64", "b": "utf8"})
    out = (
        wh.from_arrow(table).lazy().select("id", wh.col("s").struct.json_encode().str.json_decode(dtype).alias("back")).sort("id").collect()
    )
    assert out.to_arrow().column("back").to_pylist() == table.column("s").to_pylist()


# ---------------------------------------------------------------------------
# nested JSON files
# ---------------------------------------------------------------------------

RECORDS = [
    {"id": 1, "user": {"name": "ann", "tags": ["a", "b"], "geo": {"lat": 1.5, "lon": 2}}, "events": [{"k": "x", "n": 1}, {"k": "y"}]},
    {"id": 2, "user": {"name": "bob", "tags": []}, "events": []},
    {"id": 3, "user": None, "events": None},
    {"id": 4, "user": {"name": None, "tags": None, "geo": {"lat": 3.0, "lon": None}}, "events": [{"k": None, "n": 5}]},
    {"id": 5},
]


@pytest.fixture(scope="module")
def ndjson(tmp_path_factory: pytest.TempPathFactory) -> str:
    path = str(tmp_path_factory.mktemp("json") / "n.ndjson")
    with open(path, "w", encoding="utf8") as f:
        for r in RECORDS:
            f.write(json.dumps(r) + "\n")
    return path


def test_nested_ndjson_matches_polars(ndjson: str) -> None:
    ours = wh.read_ndjson(ndjson)
    theirs = pl.read_ndjson(ndjson)
    assert values(ours) == values(theirs)
    assert ours.schema["user"] == "Struct<name: Utf8, tags: List<Utf8>, geo: Struct<lat: Float64, lon: Int64>>"
    assert ours.schema["events"] == "List<Struct<k: Utf8, n: Int64>>"


def test_nested_ndjson_matches_duckdb(ndjson: str) -> None:
    p = ndjson.replace(chr(92), "/")
    for q in [
        f"select id, user, events from read_json('{p}') order by id",
        f"select id, user.name, user.tags[1], user.geo.lat, events[1].k from read_json('{p}') order by id",
        f"select id, unnest(events) as e from read_json('{p}') order by id",
    ]:
        ours = wh.sql(q).collect().to_arrow()
        exp = duckdb.connect().execute(q).arrow().read_all()
        # DuckDB types the integer lat of record 4 as DOUBLE too
        assert diff(ours, exp) is None, q


def test_nested_text_option(ndjson: str) -> None:
    text = wh.read_ndjson(ndjson, nested="text")
    assert text.schema["user"] == "Utf8"
    assert json.loads(text.to_arrow().column("user")[0].as_py())["name"] == "ann"
    via_sql = wh.sql(f"select user from read_json('{ndjson.replace(chr(92), '/')}', nested := 'text') where id = 2").collect().to_arrow()
    assert json.loads(via_sql.column("user")[0].as_py()) == {"name": "bob", "tags": []}
    # the text can be decoded with the struct dtype
    dtype = wh.Struct({"name": "utf8", "tags": wh.List("utf8")})
    back = text.lazy().select("id", wh.col("user").str.json_decode(dtype).alias("u")).filter(wh.col("id") == 2).collect()
    assert back.to_arrow().column("u").to_pylist() == [{"name": "bob", "tags": []}]


def test_conflicting_json_types_fall_back_to_text(tmp_path) -> None:
    path = str(tmp_path / "c.ndjson")
    with open(path, "w") as f:
        f.write('{"a": {"x": 1, "y": [1]}, "b": 5}\n{"a": {"x": "s", "y": [2, 3]}, "b": {"k": 1}}\n')
    df = wh.read_ndjson(path)
    assert df.schema["a"] == "Struct<x: Utf8, y: List<Int64>>"
    assert df.schema["b"] == "Utf8"
    assert df.to_arrow().to_pylist() == [{"a": {"x": "1", "y": [1]}, "b": "5"}, {"a": {"x": "s", "y": [2, 3]}, "b": '{"k": 1}'}]


def test_write_ndjson_of_structs_matches_polars(table: pa.Table, tmp_path) -> None:
    ours = str(tmp_path / "ours.ndjson")
    wh.from_arrow(table.select(["id", "s", "n", "ls", "d"])).write_ndjson(ours)
    theirs = str(tmp_path / "theirs.ndjson")
    pl.from_arrow(table.select(["id", "s", "n", "ls", "d"])).write_ndjson(theirs)
    a = [json.loads(line) for line in open(ours, encoding="utf8")]
    b = [json.loads(line) for line in open(theirs, encoding="utf8")]
    assert a == b
    # and it reads back
    back = wh.read_ndjson(ours)
    assert back.to_arrow().column("s").to_pylist() == table.column("s").to_pylist()
    assert back.to_arrow().column("n").to_pylist() == table.column("n").to_pylist()
