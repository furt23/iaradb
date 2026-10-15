"""Data Wrangler recipes: compiled to SQL in the kernel, run over all rows."""

from __future__ import annotations

import os
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
