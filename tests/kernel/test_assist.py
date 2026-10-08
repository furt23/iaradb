"""Code assistance: completions, signatures and diagnostics."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

import workhouse as wh
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


def test_redefinition_across_cells_is_an_error():
    code = "import os\ndf = 1\n_private = 2\ndef helper():\n    df = 3"
    diags = lint_python(code, others={"df", "helper", "os", "_private"})
    assert spans(code, diags) == [("os", "error"), ("df", "error"), ("helper", "error")]


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
    code = "wh.col('x').rolling_su"
    [item] = complete(code, len(code), {"wh": wh})["items"]
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
    [d] = lint({"cell_id": "b", "kind": "python", "code": "rate = 3"})
    assert d["severity"] == "error"
    assert lint({"cell_id": "q", "kind": "sql", "code": "select grp, sum(amount) from sales group by grp"}) == []
    [d] = lint({"cell_id": "q", "kind": "sql", "code": "select amont from sales"})
    assert "amont" in d["message"]
    # a frame another cell defines but has not computed yet
    assert lint({"cell_id": "z", "kind": "sql", "code": "select * from counts"}) == []
