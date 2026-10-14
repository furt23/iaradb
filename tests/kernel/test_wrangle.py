"""Data Wrangler recipes: compiled to SQL in the kernel, run over all rows."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pyarrow as pa
import pytest

from workhouse.kernel.session import KernelSession


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
    assert 'ws.sql("""' in out["python"] and "source=df" in out["python"]


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
