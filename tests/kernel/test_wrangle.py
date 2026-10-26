"""Data Wrangler recipes: compiled to SQL in the kernel, run over all rows."""

from __future__ import annotations

import os
from datetime import date, datetime
from pathlib import Path
from typing import Any

import pyarrow as pa
import pytest

from iara.kernel.session import KernelSession


@pytest.fixture()
def session(workspace: Path):
    cwd = os.getcwd()
    s = KernelSession(workspace)
    yield s
    os.chdir(cwd)


def call(session: KernelSession, method: str, **p: Any) -> Any:
    return session.handlers()[method](p, lambda event, data: None)


def step(**op: Any) -> dict[str, Any]:
    return {"id": op["kind"], "enabled": True, "op": op}


def python_rows(session: KernelSession, out: dict[str, Any], src: dict[str, Any]) -> list[dict[str, Any]]:
    """Run the exported Python as a notebook would (``ws``, and ``df`` for a result)."""
    import iara as ia

    # what a notebook cell sees: the setup cell's `ws`
    scope: dict[str, Any] = {"ws": session.ws}
    if "result_id" in src:
        scope["df"] = ia.from_arrow(session.results.get(src["result_id"]))
    exec(out["python"], scope)  # noqa: S102
    return scope["wrangled"].collect().to_arrow().to_pylist()


def sql_rows(session: KernelSession, out: dict[str, Any], src: dict[str, Any]) -> list[dict[str, Any]]:
    tables = {"source": session.results.get(src["result_id"])} if "result_id" in src else {}
    return session.ws.sql(out["sql"], **tables).collect().to_arrow().to_pylist()


def people(session: KernelSession) -> dict[str, str]:
    t = pa.table({"name": [" Ana ", "bob", None, "Bob", "carl", ""], "city": ["Rio", "SP", "SP", None, "Rio", "SP"], "age": [30, None, 41, 25, None, 19]})
    rid = session.results.put(t, "people")["id"]
    return {"result_id": rid}


def test_steps_run_over_all_rows_and_export_the_same_sql(session: KernelSession):
    src = people(session)
    steps = [
        step(kind="text_trim", column="name"),
        step(kind="fill_null", column="age", strategy="mean"),
        step(kind="filter", column="name", op="contains", value="b"),
        step(kind="rename_column", **{"from": "city", "to": "town"}),
        step(kind="sort", column="age", descending=True),
    ]
    out = call(session, "wrangle.preview", source=src, steps=steps)
    assert [c["name"] for c in out["columns"]] == ["name", "town", "age"]
    # case-sensitive: 'carl' and ' Ana ' have no 'b'; the mean 28.75 fills an integer column (rounded)
    assert out["rows"] == [["bob", "SP", 29], ["Bob", None, 25]] and out["num_rows"] == 2
    again = session.ws.sql(out["sql"], source=session.results.get(src["result_id"])).collect().to_arrow().to_pylist()
    assert again == [{"name": "bob", "town": "SP", "age": 29}, {"name": "Bob", "town": None, "age": 25}]
    assert "df.lazy()" in out["python"] and ".rename({\"city\": \"town\"})" in out["python"]
    assert python_rows(session, out, src) == again


def test_quality_counts_nulls_and_empty_strings(session: KernelSession):
    out = call(session, "wrangle.preview", source=people(session), steps=[])
    q = {c["name"]: c for c in out["quality"]}
    assert q["name"]["nulls"] == 1 and q["name"]["empty"] == 1 and q["name"]["total"] == 6
    assert q["age"]["nulls"] == 2 and q["age"]["empty"] == 0


def test_table_source_dedup_split_one_hot_and_profile(session: KernelSession):
    src = {"table": "sales"}
    steps = [
        step(kind="filter", column="grp", op="less_than", value="3"),
        step(kind="deduplicate", subset=["grp"]),
        step(kind="one_hot_encode", column="grp"),
        step(kind="sort", column="grp", descending=False),
    ]
    out = call(session, "wrangle.preview", source=src, steps=steps)
    names = [c["name"] for c in out["columns"]]
    assert names[-3:] == ["grp_0", "grp_1", "grp_2"] and out["num_rows"] == 3
    assert [r[names.index("grp_1")] for r in out["rows"]] == [0, 1, 0]
    p = call(session, "wrangle.profile", source=src, steps=[], column="amount")
    assert p["total"] == 1000 and p["distinct"] == 1000 and p["min"] == 0.0 and p["max"] == 499.5
    top = call(session, "wrangle.profile", source=src, steps=[], column="grp")["top"]
    assert top[0]["count"] == 143 and len(top) == 7


def test_split_and_regex_replace(session: KernelSession):
    t = pa.table({"email": ["a.b@x.com", "c@y.org", None]})
    src = {"result_id": session.results.put(t, "e")["id"]}
    steps = [
        step(kind="split_column", column="email", delimiter="@", numParts=2),
        step(kind="text_replace", column="email_2", pattern=r"\.(com|org)$", replacement="", isRegex=True),
    ]
    out = call(session, "wrangle.preview", source=src, steps=steps)
    assert [r[1:] for r in out["rows"]] == [["a.b", "x"], ["c", "y"], [None, None]]


def test_a_bad_step_names_itself(session: KernelSession):
    with pytest.raises(ValueError, match="step 'Round': round needs a numeric column"):
        call(session, "wrangle.preview", source=people(session), steps=[{"id": "r", "enabled": True, "label": "Round", "op": {"kind": "math_round", "column": "name", "decimals": 1}}])


def test_row_wise_steps_and_filters_fold_into_one_select(session: KernelSession):
    steps = [
        step(kind="text_trim", column="name"),
        step(kind="text_case", column="name", mode="upper"),
        step(kind="filter", column="name", op="starts_with", value="B"),
        step(kind="rename_column", **{"from": "city", "to": "town"}),
        step(kind="fill_null", column="age", strategy="constant", value=0),
        step(kind="sort", column="age", descending=True),
    ]
    out = call(session, "wrangle.preview", source=people(session), steps=steps)
    assert "WITH" not in out["sql"] and out["sql"].count("SELECT") == 1
    # the filter sees the trimmed, upper-cased name; the sort follows the renamed column's data
    assert 'starts_with(upper(trim("name")), \'B\')' in out["sql"]
    assert out["rows"] == [["BOB", "SP", 0], ["BOB", None, 25]] or out["rows"] == [["BOB", None, 25], ["BOB", "SP", 0]]
    assert [r[2] for r in out["rows"]] == [25, 0]


def test_a_fill_sees_the_rows_left_before_it_and_not_after(session: KernelSession):
    src = people(session)
    # the rows with a city have ages 30, 41, 19 and two nulls: their mean (30) fills the nulls
    before = [step(kind="filter", column="city", op="is_not_null"), step(kind="fill_null", column="age", strategy="mean")]
    out = call(session, "wrangle.preview", source=src, steps=before)
    assert sorted(r[2] for r in out["rows"]) == [19, 30, 30, 30, 41] and out["sql"].count(" AS (") == 1
    # filtering after the fill keeps the mean of all rows (28.75 -> 29) and filters the filled value
    after = [step(kind="fill_null", column="age", strategy="mean"), step(kind="filter", column="age", op="equals", value=29)]
    out = call(session, "wrangle.preview", source=src, steps=after)
    assert out["num_rows"] == 2 and "WHERE \"age\" = 29" in out["sql"]


def test_dedup_and_distinct_start_a_new_stage_only_when_needed(session: KernelSession):
    src = people(session)
    # a filter after QUALIFY must see the deduped rows: one row per city, then the null ages go
    out = call(session, "wrangle.preview", source=src, steps=[step(kind="deduplicate", subset=["city"]), step(kind="filter", column="age", op="is_not_null")])
    assert "stage_1 AS (" in out["sql"] and out["num_rows"] <= 3
    # a filter before DISTINCT folds into the same SELECT
    out = call(session, "wrangle.preview", source=src, steps=[step(kind="drop_columns", columns=["name", "age"]), step(kind="filter", column="city", op="is_not_null"), step(kind="deduplicate")])
    assert "WITH" not in out["sql"] and "SELECT DISTINCT" in out["sql"] and out["num_rows"] == 2


def test_a_long_recipe_folds_within_the_parser_limits(session: KernelSession):
    ops = [
        dict(kind="text_trim", column="name"),
        dict(kind="filter", column="age", op="greater_equal", value=0),
        dict(kind="text_case", column="name", mode="lower"),
        dict(kind="math_round", column="age", decimals=0),
    ]
    steps = [{"id": str(i), "enabled": True, "op": ops[i % 4]} for i in range(100)]
    out = call(session, "wrangle.preview", source=people(session), steps=steps)
    # 100 steps nest name and age 25 deep each: a few stages, not 100 CTEs
    assert 2 <= out["sql"].count(" AS (") <= 6
    assert sorted(r[2] for r in out["rows"]) == [19, 25, 30, 41]
    assert {r[0] for r in out["rows"]} == {"ana", None, "bob", ""}


RECIPES = {
    "filters": [
        step(kind="filter", column="age", op="between", value="20", value2="40"),
        step(kind="filter", column="city", op="not_equals", value="Rio"),
        step(kind="filter", column="name", op="not_contains", value="x"),
        step(kind="filter", column="age", op="starts_with", value="4"),
    ],
    "text": [
        step(kind="text_trim", column="name"),
        step(kind="text_case", column="name", mode="title"),
        step(kind="text_replace", column="city", pattern="S", replacement="s", isRegex=False),
        step(kind="filter", column="name", op="ends_with", value="b"),
    ],
    "columns": [
        step(kind="cast", column="age", toType="float64"),
        step(kind="math_round", column="age", decimals=0),
        step(kind="drop_columns", columns=["city"]),
        step(kind="rename_column", **{"from": "name", "to": "who"}),
        step(kind="filter", column="who", op="is_not_null"),
    ],
    "fills": [
        step(kind="fill_null", column="name", strategy="mode"),
        step(kind="fill_null", column="city", strategy="constant", value="?"),
        step(kind="filter", column="city", op="is_not_null"),
        step(kind="fill_null", column="age", strategy="median"),
    ],
    "nulls and dedup": [
        step(kind="drop_nulls", columns=["name"]),
        step(kind="deduplicate", subset=["city"]),
        step(kind="drop_nulls"),
    ],
    "split and one-hot": [
        step(kind="split_column", column="name", delimiter="b", numParts=3),
        step(kind="one_hot_encode", column="city"),
        step(kind="sort", column="age", descending=False),
    ],
}


@pytest.mark.parametrize("name", list(RECIPES))
def test_the_python_export_gives_the_same_rows_as_the_sql(session: KernelSession, name: str):
    src = people(session)
    out = call(session, "wrangle.preview", source=src, steps=RECIPES[name])
    assert "ws.sql" not in out["python"] and ".filter(" in out["python"] or "with_columns" in out["python"] or ".drop_nulls" in out["python"]
    got, want = python_rows(session, out, src), sql_rows(session, out, src)
    if name == "nulls and dedup":
        # dedup keeps any row of each group: compare what is kept per group
        assert len(got) == len(want) and {r["city"] for r in got} == {r["city"] for r in want}
    elif name == "split and one-hot":
        assert got == want
    else:
        assert sorted(map(repr, got)) == sorted(map(repr, want))


def test_the_python_export_of_a_catalog_table(session: KernelSession):
    src = {"table": "sales"}
    out = call(session, "wrangle.preview", source=src, steps=[step(kind="filter", column="grp", op="equals", value="3")])
    assert out["python"].startswith("from iara import functions as F\n") and 'ws.table("sales")' in out["python"]
    assert ".filter(F.col(" in out["python"]
    assert python_rows(session, out, src) == sql_rows(session, out, src)
    assert call(session, "wrangle.preview", source=src, steps=[])["python"] == 'wrangled = ws.table("sales")'


def same_rows(session: KernelSession, src: dict[str, Any], steps: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The preview of a recipe, checking that its exported Python gives the SQL's rows (in any order)."""
    out = call(session, "wrangle.preview", source=src, steps=steps)
    got, want = python_rows(session, out, src), sql_rows(session, out, src)
    assert sorted(map(repr, got)) == sorted(map(repr, want))
    return out, want


def fails(session: KernelSession, src: dict[str, Any], match: str, **op: Any) -> None:
    with pytest.raises(ValueError, match=match):
        call(session, "wrangle.preview", source=src, steps=[step(**op)])


def result(session: KernelSession, **columns: list[Any]) -> dict[str, str]:
    return {"result_id": session.results.put(pa.table(columns), "t")["id"]}


def agg(fn: str, column: str | None = None, **named: str) -> dict[str, str]:
    return {"fn": fn, **({"column": column} if column else {}), **named}


def test_group_by_aggregates_each_key(session: KernelSession):
    aggs = [
        agg("count", **{"as": "rows"}),
        agg("count", "age", **{"as": "ages"}),
        agg("count_distinct", "name", **{"as": "names"}),
        agg("sum", "age", **{"as": "total"}),
        agg("avg", "age", **{"as": "mean"}),
        agg("min", "age", **{"as": "youngest"}),
        agg("max", "name", **{"as": "last"}),
        agg("median", "age", **{"as": "mid"}),
    ]
    out, rows = same_rows(session, people(session), [step(kind="group_by", keys=["city"], aggs=aggs)])
    assert [c["name"] for c in out["columns"]] == ["city", "rows", "ages", "names", "total", "mean", "youngest", "last", "mid"]
    by_city = {r["city"]: r for r in rows}
    assert by_city["Rio"] == {"city": "Rio", "rows": 2, "ages": 1, "names": 2, "total": 30, "mean": 30.0, "youngest": 30, "last": "carl", "mid": 30.0}
    # count skips nulls, not ''
    assert by_city["SP"] == {"city": "SP", "rows": 3, "ages": 2, "names": 2, "total": 60, "mean": 30.0, "youngest": 19, "last": "bob", "mid": 30.0}
    assert by_city[None]["rows"] == 1 and by_city[None]["total"] == 25 and len(rows) == 3


def test_group_by_without_keys_is_one_row_and_without_aggregations_the_distinct_keys(session: KernelSession):
    src = people(session)
    out, rows = same_rows(session, src, [step(kind="group_by", keys=[], aggs=[agg("count", **{"as": "n"}), agg("sum", "age", **{"as": "total"})])])
    assert rows == [{"n": 6, "total": 115}] and "GROUP BY" not in out["sql"]
    out, rows = same_rows(session, src, [step(kind="group_by", keys=["city"], aggs=[])])
    assert {r["city"] for r in rows} == {"Rio", "SP", None} and len(rows) == 3


def test_group_by_rejects_what_it_cannot_compute(session: KernelSession):
    src = people(session)
    fails(session, src, "sum needs a numeric column; name is", kind="group_by", keys=["city"], aggs=[agg("sum", "name", **{"as": "s"})])
    fails(session, src, "median needs a numeric column", kind="group_by", keys=[], aggs=[agg("median", "city", **{"as": "m"})])
    fails(session, src, "sum needs a column", kind="group_by", keys=["city"], aggs=[agg("sum", **{"as": "s"})])
    fails(session, src, "must be different", kind="group_by", keys=["city"], aggs=[agg("count", **{"as": "city"})])
    fails(session, src, "needs a key or an aggregation", kind="group_by", keys=[], aggs=[])
    fails(session, src, "unknown column 'nope'", kind="group_by", keys=["nope"], aggs=[])
    fails(session, src, "unknown aggregation 'mode'", kind="group_by", keys=[], aggs=[agg("mode", "age", **{"as": "m"})])


def test_a_group_by_starts_a_stage_and_later_steps_read_its_columns(session: KernelSession):
    steps = [
        step(kind="rename_column", **{"from": "city", "to": "town"}),
        step(kind="group_by", keys=["town"], aggs=[agg("count", **{"as": "n"})]),
        step(kind="text_case", column="town", mode="upper"),
        step(kind="filter", column="n", op="greater_than", value=1),
    ]
    out, rows = same_rows(session, people(session), steps)
    assert sorted(tuple(r.values()) for r in rows) == [("RIO", 2), ("SP", 3)]
    assert out["sql"].count(" AS (") == 2  # the rename, the grouping; the rest folds into the last SELECT


def test_a_chain_of_filter_group_by_sort_and_rename(session: KernelSession):
    src = {"table": "sales"}
    steps = [
        step(kind="filter", column="id", op="less_than", value=100),
        step(kind="group_by", keys=["grp"], aggs=[agg("count", **{"as": "n"}), agg("sum", "amount", **{"as": "total"})]),
        step(kind="sort", column="total", descending=True),
        step(kind="rename_column", **{"from": "total", "to": "amount"}),
    ]
    out = call(session, "wrangle.preview", source=src, steps=steps)
    sums = {g: sum(i * 0.5 for i in range(100) if i % 7 == g) for g in range(7)}
    want = sorted(((g, sum(1 for i in range(100) if i % 7 == g), t) for g, t in sums.items()), key=lambda r: -r[2])
    assert [c["name"] for c in out["columns"]] == ["grp", "n", "amount"]
    assert out["rows"] == [list(r) for r in want]
    # the sort follows the renamed column, in the SQL and in the Python
    assert 'ORDER BY "amount" DESC' in out["sql"]
    assert python_rows(session, out, src) == sql_rows(session, out, src) == [dict(zip(("grp", "n", "amount"), r)) for r in want]
    # profiles read the grouped rows
    assert call(session, "wrangle.profile", source=src, steps=steps, column="n")["total"] == 7
    # a sort on a column the grouping dropped is gone
    gone = call(session, "wrangle.preview", source=src, steps=[step(kind="sort", column="amount"), step(kind="group_by", keys=["grp"], aggs=[])])
    assert "ORDER BY" not in gone["sql"] and gone["num_rows"] == 7


def test_join_adds_columns_of_a_catalog_table(session: KernelSession):
    src = {"table": "sales"}
    on = [{"left": "grp", "right": "grp"}]
    first = step(kind="filter", column="id", op="less_than", value=10)
    out, rows = same_rows(session, src, [first, step(kind="join", table="regions", how="left", on=on, columns=["region"])])
    assert [c["name"] for c in out["columns"]] == ["id", "grp", "amount", "region"] and len(rows) == 10
    # ids 0..9 have groups 0..6, and the regions know 0..3
    assert sorted(r["id"] for r in rows if r["region"] is None) == [4, 5, 6]
    assert {r["id"]: r["region"] for r in rows if r["region"]} == {0: "north", 1: "south", 2: "east", 3: "west", 7: "north", 8: "south", 9: "east"}
    out, rows = same_rows(session, src, [first, step(kind="join", table="regions", how="inner", on=on, columns=["region"])])
    assert len(rows) == 7 and all(r["region"] for r in rows)
    assert "LEFT JOIN" not in out["sql"] and "INNER JOIN" in out["sql"] and 'ws.table("regions")' in out["python"]


def test_join_on_columns_with_other_names_skips_null_keys_and_prefixes_a_name_the_result_has(session: KernelSession):
    src = result(session, k=[1, 2, None], v=["a", "b", "c"], region=["r1", "r2", "r3"])
    join = step(kind="join", table="regions", how="left", on=[{"left": "k", "right": "grp"}], columns=["grp", "region"])
    out, rows = same_rows(session, src, [join])
    # `region` is taken, so the table's is `regions_region`; `grp` is new; a null key matches nothing
    assert [c["name"] for c in out["columns"]] == ["k", "v", "region", "grp", "regions_region"]
    assert sorted(rows, key=lambda r: r["v"]) == [
        {"k": 1, "v": "a", "region": "r1", "grp": 1, "regions_region": "south"},
        {"k": 2, "v": "b", "region": "r2", "grp": 2, "regions_region": "east"},
        {"k": None, "v": "c", "region": "r3", "grp": None, "regions_region": None},
    ]
    # the prefixed name is taken too
    taken = result(session, grp=[1], region=["r"], regions_region=["x"])
    fails(session, taken, "'regions_region' is already a column", kind="join", table="regions", how="inner", on=[{"left": "grp", "right": "grp"}], columns=["region"])


def test_join_checks_its_columns_and_pairs(session: KernelSession):
    src = {"table": "sales"}
    ok = [{"left": "grp", "right": "grp"}]
    fails(session, src, "at least one pair", kind="join", table="regions", how="inner", on=[], columns=["region"])
    fails(session, src, "unknown column 'nope'", kind="join", table="regions", how="inner", on=[{"left": "nope", "right": "grp"}], columns=[])
    fails(session, src, "regions has no column 'nope'", kind="join", table="regions", how="inner", on=[{"left": "grp", "right": "nope"}], columns=[])
    fails(session, src, "regions has no column 'nope'", kind="join", table="regions", how="inner", on=ok, columns=["nope"])
    fails(session, src, "only once", kind="join", table="regions", how="inner", on=ok + [{"left": "grp", "right": "region"}], columns=[])
    fails(session, src, "unknown join 'outer'", kind="join", table="regions", how="outer", on=ok, columns=[])
    fails(session, src, "step 'join'", kind="join", table="nope", how="inner", on=ok, columns=[])


def dates(session: KernelSession) -> dict[str, str]:
    return result(
        session,
        d=[date(2024, 1, 1), date(2024, 12, 29), date(2025, 1, 5), None],
        ts=[datetime(2024, 3, 15, 13, 5), datetime(2024, 7, 1), None, datetime(2025, 2, 28, 23, 59)],
        n=[1, 2, 3, 4],
    )


def test_date_parts_and_truncations(session: KernelSession):
    parts = ["year", "quarter", "month", "week", "day", "weekday"]
    steps = [step(kind="date_part", column="d", part=p, **{"as": f"d_{p}"}) for p in parts]
    steps += [
        step(kind="date_trunc", column="d", unit="week", **{"as": "d_week_start"}),
        step(kind="date_trunc", column="ts", unit="quarter", **{"as": "ts_quarter"}),
        step(kind="date_part", column="ts", part="month", **{"as": "ts_month"}),
    ]
    out, rows = same_rows(session, dates(session), steps)
    assert out["sql"].count("SELECT") == 1  # row-wise: one SELECT
    by_n = {r["n"]: r for r in rows}
    # Monday 2024-01-01; Sunday 2024-12-29 (ISO week 52); Sunday 2025-01-05 (ISO week 1 of 2025)
    assert [by_n[1][f"d_{p}"] for p in parts] == [2024, 1, 1, 1, 1, 1]
    assert [by_n[2][f"d_{p}"] for p in parts] == [2024, 4, 12, 52, 29, 0]
    assert [by_n[3][f"d_{p}"] for p in parts] == [2025, 1, 1, 1, 5, 0]
    assert all(by_n[4][f"d_{p}"] is None for p in parts)
    assert by_n[2]["d_week_start"] == date(2024, 12, 23) and by_n[1]["ts_quarter"] == datetime(2024, 1, 1) and by_n[4]["ts_month"] == 2
    assert by_n[3]["ts_quarter"] is None


def test_a_date_step_replaces_a_column_of_that_name_in_place(session: KernelSession):
    out, rows = same_rows(session, dates(session), [step(kind="date_trunc", column="d", unit="month", **{"as": "d"})])
    assert [c["name"] for c in out["columns"]] == ["d", "ts", "n"]
    assert sorted(r["d"] for r in rows if r["d"]) == [date(2024, 1, 1), date(2024, 12, 1), date(2025, 1, 1)]


def test_date_steps_need_a_date_or_timestamp_column(session: KernelSession):
    src = dates(session)
    fails(session, src, "n is not a date or timestamp column", kind="date_part", column="n", part="year", **{"as": "y"})
    fails(session, src, "n is not a date or timestamp column", kind="date_trunc", column="n", unit="day", **{"as": "y"})
    fails(session, src, "unknown date part 'hour'", kind="date_part", column="d", part="hour", **{"as": "y"})
    fails(session, src, "unknown date unit 'hour'", kind="date_trunc", column="d", unit="hour", **{"as": "y"})


def test_a_calculated_column_is_added_or_replaced_in_place(session: KernelSession):
    # text in quotes may hold what the scanner rejects outside them
    quoted = """upper(trim("name")) || ' ; -- /* select ('"""
    steps = [
        step(kind="rename_column", **{"from": "age", "to": "years"}),
        step(kind="calculated", name="months", expression="years * 12"),
        # a backslash must survive the Python export
        step(kind="calculated", name="compact", expression="""regexp_replace("name", '\\s', '', 'g')"""),
        step(kind="calculated", name="name", expression=quoted),
    ]
    out, rows = same_rows(session, people(session), steps)
    assert [c["name"] for c in out["columns"]] == ["name", "city", "years", "months", "compact"]
    by_years = {r["years"]: r for r in rows}
    assert by_years[30]["months"] == 360 and by_years[30]["name"] == "ANA ; -- /* select (" and by_years[30]["compact"] == "Ana"
    assert by_years[None]["months"] is None and len(rows) == 6
    # the expression reads the renamed column, so it starts a stage
    assert "stage_1 AS (" in out["sql"]


@pytest.mark.parametrize(
    "expression, match",
    [
        ("", "empty"),
        ("  ", "empty"),
        pytest.param("1" * 2001, "longer than 2000", id="too long"),
        ("age; DROP TABLE x", "';'"),
        ("(SELECT max(age) FROM t)", "subquery"),
        ("(select 1)", "subquery"),
        ("age -- note", "comments"),
        ("age /* note */", "comments"),
        ("(age + 1", "parentheses"),
        ("age + 1)", "parentheses"),
        (") age (", "parentheses"),
        ("name = 'open", "quote is not closed"),
        ('"open', "quote is not closed"),
    ],
)
def test_a_calculated_expression_is_scanned_before_it_is_used(session: KernelSession, expression: str, match: str):
    fails(session, people(session), match, kind="calculated", name="x", expression=expression)


def test_a_calculated_column_needs_a_name_and_columns_that_exist(session: KernelSession):
    src = people(session)
    fails(session, src, "needs a name", kind="calculated", name=" ", expression="age")
    with pytest.raises(ValueError, match="step 'Mine'"):
        call(session, "wrangle.preview", source=src, steps=[{**step(kind="calculated", name="x", expression="nope + 1"), "label": "Mine"}])


def test_pivot_makes_a_column_per_value(session: KernelSession):
    src = result(
        session,
        region=["n", "n", "s", "s", "s"],
        q=["Q1", "Q2", "Q1", "Q1", "Q2"],
        year=[2023, 2023, 2024, 2024, 2024],
        amt=[10, 20, 5, 7, None],
    )
    out, rows = same_rows(session, src, [step(kind="pivot", index=["region"], column="q", value="amt", agg="sum")])
    assert [c["name"] for c in out["columns"]] == ["region", "Q1", "Q2"]
    assert sorted(rows, key=lambda r: r["region"]) == [{"region": "n", "Q1": 10, "Q2": 20}, {"region": "s", "Q1": 12, "Q2": None}]
    # no index: one row; a number column's values are named by their text; count skips nulls
    out, rows = same_rows(session, src, [step(kind="pivot", index=[], column="year", value="amt", agg="count")])
    assert rows == [{"2023": 2, "2024": 2}]
    out, rows = same_rows(session, src, [step(kind="pivot", index=["region", "q"], column="year", value="amt", agg="avg")])
    assert {(r["region"], r["q"]): (r["2023"], r["2024"]) for r in rows} == {("n", "Q1"): (10.0, None), ("n", "Q2"): (20.0, None), ("s", "Q1"): (None, 6.0), ("s", "Q2"): (None, None)}


def test_a_pivot_of_values_with_quotes_exports_valid_python(session: KernelSession):
    src = result(session, k=[1, 1, 2], c=['say "hi"', "it's", 'ends"'], v=[1, 2, 3])
    out, rows = same_rows(session, src, [step(kind="pivot", index=["k"], column="c", value="v", agg="max")])
    assert sorted(rows[0]) == sorted(["k", 'ends"', "it's", 'say "hi"']) and len(rows) == 2


def test_pivot_rejects_too_many_values_and_clashing_names(session: KernelSession):
    many = result(session, k=list(range(51)), v=list(range(51)))
    fails(session, many, "more than 50 distinct values: too many for pivot columns", kind="pivot", index=[], column="k", value="v", agg="sum")
    ok = result(session, k=list(range(50)), v=list(range(50)))
    assert call(session, "wrangle.preview", source=ok, steps=[step(kind="pivot", index=[], column="k", value="v", agg="sum")])["num_rows"] == 1
    clash = result(session, Q1=[1, 2], q=["Q1", "Q2"], amt=[1, 2])
    fails(session, clash, "'Q1' of q is also an index column", kind="pivot", index=["Q1"], column="q", value="amt", agg="sum")
    fails(session, clash, "sum needs a numeric column; q is", kind="pivot", index=["Q1"], column="amt", value="q", agg="sum")
    fails(session, clash, "unknown column 'nope'", kind="pivot", index=["nope"], column="q", value="amt", agg="sum")
    fails(session, clash, "unknown aggregation 'median'", kind="pivot", index=[], column="q", value="amt", agg="median")


def test_unpivot_makes_a_row_per_column(session: KernelSession):
    src = result(session, id=[1, 2], a=[1, 2], b=[3, 4], c=[1.5, None], s=["x", "y"])
    # the type they share is kept
    out, rows = same_rows(session, src, [step(kind="unpivot", columns=["a", "b"], name="col", value="val")])
    assert {c["name"]: c["type"] for c in out["columns"]} == {"id": "int64", "c": "double", "s": "string", "col": "string", "val": "int64"}
    assert len(rows) == 4 and {(r["id"], r["col"]): r["val"] for r in rows} == {(1, "a"): 1, (2, "a"): 2, (1, "b"): 3, (2, "b"): 4}
    # numbers of different types are doubles; nulls stay rows
    out, rows = same_rows(session, src, [step(kind="unpivot", columns=["a", "c"], name="col", value="val")])
    assert out["columns"][-1]["type"] == "double"
    assert {(r["id"], r["col"]): r["val"] for r in rows} == {(1, "a"): 1.0, (2, "a"): 2.0, (1, "c"): 1.5, (2, "c"): None}
    # a number and a text become text
    out, rows = same_rows(session, src, [step(kind="unpivot", columns=["a", "s"], name="col", value="val")])
    assert out["columns"][-1]["type"] == "string"
    assert {(r["id"], r["col"]): r["val"] for r in rows} == {(1, "a"): "1", (2, "a"): "2", (1, "s"): "x", (2, "s"): "y"}


def test_unpivot_checks_its_columns_and_names(session: KernelSession):
    src = result(session, id=[1], a=[1], b=[2])
    fails(session, src, "at least one column", kind="unpivot", columns=[], name="col", value="val")
    fails(session, src, "unknown column 'nope'", kind="unpivot", columns=["nope"], name="col", value="val")
    fails(session, src, "must be different", kind="unpivot", columns=["a", "a"], name="col", value="val")
    fails(session, src, "'id' and 'val' must differ", kind="unpivot", columns=["a"], name="id", value="val")
    fails(session, src, "'col' and 'col' must differ", kind="unpivot", columns=["a"], name="col", value="col")
    # a name may reuse an unpivoted column's
    out = call(session, "wrangle.preview", source=src, steps=[step(kind="unpivot", columns=["a", "b"], name="a", value="b")])
    assert [c["name"] for c in out["columns"]] == ["id", "a", "b"] and out["num_rows"] == 2


def test_wrangle_sql_returns_the_sql_of_the_preview(session: KernelSession):
    cases = [
        ({"table": "sales"}, [step(kind="group_by", keys=["grp"], aggs=[agg("count", **{"as": "n"})]), step(kind="sort", column="n", descending=False)]),
        (people(session), [step(kind="rename_column", **{"from": "city", "to": "town"}), step(kind="calculated", name="x", expression="age + 1")]),
        (people(session), []),
    ]
    for src, steps in cases:
        assert call(session, "wrangle.sql", source=src, steps=steps) == {"sql": call(session, "wrangle.preview", source=src, steps=steps)["sql"]}
    with pytest.raises(ValueError, match="step 'sort': unknown column"):
        call(session, "wrangle.sql", source=people(session), steps=[step(kind="sort", column="nope")])
