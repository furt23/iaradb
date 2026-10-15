"""Code assistance: completions, signatures and diagnostics."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

import workhouse as wh
from workhouse import functions as F
from workhouse.kernel.assist import complete, lint_python, lint_sql, signature
from workhouse.kernel.session import KernelSession


def spans(code: str, diags: list[dict]) -> list[tuple[str, str]]:
    return [(code[d["from"] : d["to"]], d["severity"]) for d in diags]


# -- Python diagnostics ------------------------------------------------------


def test_syntax_error_is_located():
    code = "x = 1\ny = (2 +\nz = 3"
    [d] = lint_python(code, set())
    assert d["severity"] == "error" and d["message"].startswith("SyntaxError")
    assert code.count("\n", 0, d["from"]) == 1  # on the line of the unclosed parenthesis


def test_undefined_names_are_warnings():
    code = "total = price * qty\nprint(totl, len(items))"
    diags = lint_python(code, others={"price"}, available={"items"})
    assert spans(code, diags) == [("qty", "warning"), ("totl", "warning")]


def test_scoping_does_not_produce_false_positives():
    code = "def f(a):\n    return [b for b in a]\nclass C:\n    k = 1\nwith open('x') as fh:\n    pass\n(n := 3)\nprint(f, C, fh, n)"
    assert lint_python(code, set()) == []


def test_unicode_columns():
    code = "é = 1\nprint(é, ñ)"
    assert spans(code, lint_python(code, set())) == [("ñ", "warning")]


def test_a_cell_may_redefine_other_cells_names():
    code = "import os\ndf = 1\n_private = 2\ndef helper():\n    df = 3"
    assert lint_python(code, others={"df", "helper", "os", "_private"}) == []
    # reading a name before rebinding it needs another cell to define it
    code = "df = df.filter(x)"
    assert lint_python(code, others={"df", "x"}) == []
    assert spans(code, lint_python(code, others={"x"})) == [("df", "warning")]


def test_unknown_notebook_and_star_imports_skip_name_checks():
    assert lint_python("print(x)", None) == []
    assert lint_python("from math import *\nprint(sqrt, x)", set()) == []


# -- SQL diagnostics ---------------------------------------------------------


@pytest.fixture()
def ctx() -> wh.SessionContext:
    c = wh.SessionContext()
    c.register("t", wh.from_dict({"a": [1, 2], "b": ["x", "y"]}))
    return c


def test_sql_parse_error_is_located(ctx):
    code = "select a\nfrom t\nwher a > 1"
    [d] = lint_sql(code, ctx.sql)
    assert code[d["from"] : d["to"]] == "a" or code[d["from"] : d["to"]] == "wher"
    assert "parser error" in d["message"]


def test_sql_unknown_column_and_table(ctx):
    code = "select nope, a from t"
    assert spans(code, lint_sql(code, ctx.sql)) == [("nope", "error")]
    code = "select * from missing"
    assert spans(code, lint_sql(code, ctx.sql)) == [("missing", "error")]


def test_sql_pending_values_are_not_errors(ctx):
    assert lint_sql("select * from df_later", ctx.sql, pending={"df_later"}) == []
    assert lint_sql("select a from t", ctx.sql) == []


# -- completion and signatures -----------------------------------------------


def test_completion_uses_live_values():
    lf = wh.from_dict({"a": [1]}).lazy()
    code = "lf.gro"
    out = complete(code, len(code), {"lf": lf})
    assert out["from"] == 3
    labels = [i["label"] for i in out["items"]]
    assert "group_by" in labels
    item = out["items"][labels.index("group_by")]
    assert item["type"] == "function" and item["detail"].startswith("(")


def test_completion_docs_and_signature():
    code = "F.col('x').rolling_su"
    [item] = complete(code, len(code), {"F": F})["items"]
    assert "rolling_sum(window_size: int" in item["signature"] and "window_size" in item["doc"]
    code = "wh.scan_csv('a.csv', "
    sig = signature(code, len(code), {"wh": wh})
    assert sig["name"] == "scan_csv" and sig["active"] == 1 and sig["params"][0].startswith("path")
    assert signature("x = 1", 5, {}) is None


# -- through the session -----------------------------------------------------


@pytest.fixture()
def session(workspace: Path):
    cwd = os.getcwd()
    s = KernelSession(workspace)
    yield s
    os.chdir(cwd)


def test_session_lint_knows_other_cells(session: KernelSession):
    session.notebook.create("notebooks/a.py")
    cells = [
        {"id": "a", "kind": "python", "code": "import workhouse as wh\nws = wh.workspace()\nrate = 2"},
        {"id": "q", "kind": "sql", "code": "select count(*) n from sales", "output": "counts"},
    ]
    session.notebook.save(cells)
    lint = session.assist.lint
    code = "print(rate * 2, counts, nope)"
    at = code.index("nope")
    assert lint({"cell_id": "b", "kind": "python", "code": code}) == [
        {"from": at, "to": at + 4, "severity": "warning", "message": "'nope' is not defined"}
    ]
    assert lint({"cell_id": "b", "kind": "python", "code": "rate = 3"}) == []
    assert lint({"cell_id": "q", "kind": "sql", "code": "select grp, sum(amount) from sales group by grp"}) == []
    [d] = lint({"cell_id": "q", "kind": "sql", "code": "select amont from sales"})
    assert "amont" in d["message"]
    # a frame another cell defines but has not computed yet
    assert lint({"cell_id": "z", "kind": "sql", "code": "select * from counts"}) == []


# -- the workhouse API -------------------------------------------------------


def labels(r: dict) -> list[str]:
    return [i["label"] for i in r["items"]]


def test_the_setup_cells_names_complete_before_it_runs(workspace: Path):
    cwd = os.getcwd()
    try:
        s = KernelSession(workspace)
        assert s.notebook.namespace() == {}
        assert {"table", "sql"} <= set(labels(s.assist.complete({"code": "ws.", "cursor": 3})))
        # the return types carry the chain on
        code = 'from workhouse import functions as F\nws.table("sales").filter(F.col("grp") > 1).with'
        assert labels(s.assist.complete({"code": code, "cursor": len(code)})) == ["with_column", "with_columns"]
        assert "scan_parquet" in labels(s.assist.complete({"code": "workhouse.", "cursor": 10}))
    finally:
        os.chdir(cwd)


def test_workhouse_completes_frames_and_functions_complete_expressions():


    top = set(labels(complete("wh.", 3, {"wh": wh})))
    assert {"scan_parquet", "sql", "workspace", "concat", "functions"} <= top
    # expressions live in `functions`; no internals either
    assert not {"col", "lit", "when", "sum", "Any", "annotations", "cli", "PyExpr", "frame_ops"} & top
    fns = set(labels(complete("F.", 2, {"F": F})))
    assert {"col", "lit", "when", "sum", "coalesce", "row_number"} <= fns and "annotations" not in fns
    # one column is an expression, not a list
    col = labels(complete('F.col("a").', 11, {"F": F}))
    assert "alias" in col and "append" not in col
