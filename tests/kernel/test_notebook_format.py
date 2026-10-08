"""Static analysis, dependency graph and the marimo file format."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from workhouse.kernel.notebook import marimo_io
from workhouse.kernel.notebook.analysis import analyze_python, sql_identifiers
from workhouse.kernel.notebook.graph import DependencyGraph
from workhouse.kernel.notebook.model import Cell


def cell(code: str, kind: str = "python", output: str | None = None, cid: str | None = None) -> Cell:
    return Cell(cid or code[:12], kind, code, output=output)


# ---------------------------------------------------------------------------
# analysis
# ---------------------------------------------------------------------------


def test_defs_and_refs():
    a = analyze_python("import math\nx = math.sqrt(y) + len(z)\n_tmp = x\ndef f(a):\n    return a + w\n")
    assert a.defs == {"math", "x", "f"}
    assert a.refs == {"y", "z", "w"}
    assert a.private == {"_tmp"}


def test_scopes_are_resolved():
    a = analyze_python("total = sum(v * k for v in values)\nclass C:\n    attr = base\n[q := 1 for _ in range(3)]")
    assert a.defs == {"total", "C", "q"}
    assert a.refs == {"values", "k", "base"}


def test_syntax_error_reported():
    assert analyze_python("x = (").error.startswith("SyntaxError")


def test_sql_identifiers_skip_literals_and_comments():
    ids = sql_identifiers("select a from t -- other\nwhere s = 'not_a_table' /* x_y */ and b > 1")
    assert {"select", "a", "t", "where", "s", "b"} <= ids
    assert not {"other", "not_a_table", "x_y"} & ids


# ---------------------------------------------------------------------------
# graph
# ---------------------------------------------------------------------------


def test_graph_edges_and_order():
    cells = [cell("b = a + 1", cid="2"), cell("a = 1", cid="1"), cell("c = b * 2", cid="3"), cell("print(a)", cid="4")]
    g = DependencyGraph(cells)
    assert g.descendants("1") == {"2", "3", "4"}
    assert g.ancestors("3") == {"1", "2"}
    assert g.topological({"1", "2", "3", "4"}) == ["1", "2", "3", "4"]
    assert not g.errors


def test_graph_errors():
    g = DependencyGraph([cell("x = 1", cid="a"), cell("x = 2", cid="b"), cell("p = q", cid="c"), cell("q = p", cid="d")])
    assert "more than one cell" in g.errors["a"] and "more than one cell" in g.errors["b"]
    assert "cycle" in g.errors["c"] and "cycle" in g.errors["d"]


def test_sql_cells_reference_frames_case_insensitively():
    g = DependencyGraph([cell("Recent = 1", cid="py"), cell("select * from recent join sales using (id)", "sql", "out", cid="sql")])
    assert g.deps["sql"].refs == ("Recent",)
    assert g.deps["sql"].parents == {"py"}


# ---------------------------------------------------------------------------
# marimo files
# ---------------------------------------------------------------------------

SAMPLE = '''import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    import workhouse as wh

    ws = wh.workspace()
    return mo, wh, ws


@app.cell(hide_code=True)
def _(mo):
    mo.md(
        r"""
    # Sales
    by *group*
    """
    )
    return


@app.cell
def _(ws):
    big = ws.sql(
        r"""
        select grp, sum(amount) as total
        from sales
        group by grp
        """,
    ).collect()
    return (big,)


@app.cell
def summary(big):
    # rows per group
    n = big.height
    text = """keep
        this indentation"""
    n
    return n, text


if __name__ == "__main__":
    app.run()
'''


def test_parse_detects_cell_kinds(tmp_path: Path):
    nb = marimo_io.parse(SAMPLE, tmp_path / "nb.py")
    assert [c.kind for c in nb.cells] == ["python", "markdown", "sql", "python"]
    assert nb.app_args == 'width="medium"'
    assert nb.generated_with == "0.25.1"
    md, sql, py = nb.cells[1], nb.cells[2], nb.cells[3]
    assert md.code == "# Sales\nby *group*" and md.config == {"hide_code": True}
    assert sql.output == "big" and sql.code.startswith("select grp") and "group by grp" in sql.code
    assert py.name == "summary" and py.code.startswith("# rows per group")
    assert 'text = """keep\n    this indentation"""' in py.code


def test_round_trip_is_stable(tmp_path: Path):
    nb = marimo_io.parse(SAMPLE, tmp_path / "nb.py")
    once = marimo_io.serialize(nb)
    again = marimo_io.serialize(marimo_io.parse(once, tmp_path / "nb.py"))
    assert once == again
    assert [c.code for c in marimo_io.parse(once, tmp_path / "nb.py").cells] == [c.code for c in nb.cells]


def test_sql_cell_passes_referenced_frames(tmp_path: Path):
    nb = marimo_io.new_notebook(tmp_path / "nb.py")
    nb.cells += [cell("recent = ws.table('sales').limit(10)", cid="p"), cell("select count(*) from recent", "sql", "n", cid="s")]
    src = marimo_io.serialize(nb)
    assert "def _(recent, ws):\n    n = ws.sql(" in src
    assert "        recent=recent,\n    ).collect()\n    return (n,)" in src


def test_written_notebook_runs_as_a_script(workspace: Path):
    nb = marimo_io.new_notebook(workspace / "notebooks" / "report.py")
    nb.cells += [
        cell("select grp, sum(amount) as total from sales group by grp", "sql", "totals", cid="s"),
        cell("assert totals.height == 7\nprint('ok', totals.height)", cid="p"),
        cell("# Title", "markdown", cid="m"),
    ]
    marimo_io.write(nb)
    r = subprocess.run([sys.executable, str(nb.path)], cwd=workspace, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
