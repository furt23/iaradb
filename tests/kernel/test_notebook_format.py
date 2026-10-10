"""Static analysis, dependency graph and the marimo file format."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

from workhouse.kernel.notebook import marimo_io
from workhouse.kernel.notebook.analysis import analyze_python, sql_identifiers
from workhouse.kernel.notebook.graph import DependencyGraph
from workhouse.kernel.notebook.model import Cell, new_cell_id


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


def test_charts_are_saved_with_their_cells_and_still_run(workspace: Path):
    nb = marimo_io.new_notebook(workspace / "notebooks" / "charted.py")
    chart = {"kind": "bar", "x": "grp", "y": ["total"], "agg": "sum", "group": None}
    sql = cell("select grp, sum(amount) as total from sales group by grp", "sql", "totals", cid="s")
    sql.config = {"chart": chart}
    nb.cells.append(sql)
    marimo_io.write(nb)
    back = marimo_io.read(nb.path)
    assert back.cells[-1].config == {"chart": chart}
    # marimo ignores options it does not know: the file still runs
    r = subprocess.run([sys.executable, str(nb.path)], cwd=workspace, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr


# ---------------------------------------------------------------------------
# stable cell ids
# ---------------------------------------------------------------------------

WITH_IDS = '''import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium")


with app.setup:
    import polars as pl


@app.cell(id="intro_1")
def _():
    x = 1
    return (x,)


@app.cell(id="abc-123", hide_code=True)
def _(x):
    y = x + 1
    return (y,)


@app.cell(id="intro_1")
def _(y):
    z = y + 1
    return (z,)


@app.cell(id="not valid!")
def _(z):
    w = z
    return (w,)


@app.cell
def _(w):
    v = w
    return (v,)


if __name__ == "__main__":
    app.run()
'''


def test_ids_are_read_from_the_decorator(tmp_path: Path):
    nb = marimo_io.parse(WITH_IDS, tmp_path / "nb.py")
    setup, a, b, dup, bad, plain = nb.cells
    assert (setup.id, a.id, b.id) == ("setup", "intro_1", "abc-123")
    # the id is not an option of the cell
    assert b.config == {"hide_code": True} and a.config == {}
    # a duplicate, an invalid id and a missing one get fresh ids
    fresh = [dup.id, bad.id, plain.id]
    assert len(set(fresh) | {"setup", "intro_1", "abc-123"}) == 6
    assert all(len(i) == 8 and i.isalnum() and i.islower() for i in fresh)


def test_ids_survive_a_round_trip(tmp_path: Path):
    path = tmp_path / "nb.py"
    nb = marimo_io.parse(WITH_IDS, path)
    once = marimo_io.serialize(nb)
    back = marimo_io.parse(once, path)
    assert [c.id for c in back.cells] == [c.id for c in nb.cells]
    assert [c.config for c in back.cells] == [c.config for c in nb.cells]
    assert marimo_io.serialize(back) == once


def test_a_file_without_ids_gets_them_on_save(tmp_path: Path):
    path = tmp_path / "nb.py"
    nb = marimo_io.parse(SAMPLE, path)
    assert "id=" not in SAMPLE
    saved = marimo_io.serialize(nb)
    for c in nb.cells:
        assert f'@app.cell(id="{c.id}"' in saved
    # the ids are now in the file: reading it again gives the same ones
    assert [c.id for c in marimo_io.parse(saved, path).cells] == [c.id for c in nb.cells]


def test_the_id_comes_first_and_the_setup_cell_has_none_written(tmp_path: Path):
    nb = marimo_io.parse(WITH_IDS, tmp_path / "nb.py")
    src = marimo_io.serialize(nb)
    assert '@app.cell(id="abc-123", hide_code=True)' in src
    assert "with app.setup:\n" in src and "@app.cell(id=\"setup\"" not in src


def test_new_cell_ids_are_short_and_distinct():
    ids = {new_cell_id() for _ in range(200)}
    assert len(ids) == 200
    assert all(re.fullmatch(r"[a-z0-9]{8}", i) for i in ids)


def test_a_cell_with_an_invalid_id_is_written_without_one(tmp_path: Path):
    nb = marimo_io.new_notebook(tmp_path / "nb.py")
    nb.cells.append(cell("a = 1", cid="has space"))
    src = marimo_io.serialize(nb)
    assert "@app.cell\ndef _():\n    a = 1" in src


def test_notebook_with_ids_and_options_still_runs(workspace: Path):
    nb = marimo_io.new_notebook(workspace / "notebooks" / "ids.py")
    md = cell("# Title", "markdown", cid="m1")
    md.config = {"hide_code": True}
    nb.cells += [cell("print('ok')", cid="p1"), md]
    marimo_io.write(nb)
    assert '@app.cell(id="m1", hide_code=True)' in nb.path.read_text(encoding="utf-8")
    r = subprocess.run([sys.executable, str(nb.path)], cwd=workspace, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
