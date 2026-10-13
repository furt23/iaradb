"""Notebook widgets: the API, dependency detection, widgets.set, SQL binding, job presets."""

from __future__ import annotations

import ast
import datetime as dt
import inspect
import os
from pathlib import Path
from typing import Any

import pytest

from workhouse import widgets
from workhouse.kernel.notebook import marimo_io
from workhouse.kernel.notebook.analysis import analyze, sql_placeholders
from workhouse.kernel.notebook.codegen import detect_sql, sql_source
from workhouse.kernel.notebook.graph import DependencyGraph
from workhouse.kernel.notebook.model import Cell, Notebook
from workhouse.kernel.session import KernelSession
from workhouse.workspaces import Workspace

from test_session import SETUP, Recorder, py, run, session, sql  # noqa: F401

PARAMS_SUPPORTED = "params" in inspect.signature(Workspace.sql).parameters


@pytest.fixture()
def standalone(monkeypatch: pytest.MonkeyPatch):
    """A fresh process-wide registry (no kernel), without WORKHOUSE_PARAM_* variables."""
    for k in [k for k in os.environ if k.startswith(widgets.ENV_PREFIX)]:
        monkeypatch.delenv(k)
    reg = widgets.Registry(env=True)
    old = widgets.active()
    widgets.install(reg)
    yield reg
    widgets.install(old)


# -- the API -------------------------------------------------------------------


def test_defaults_and_get(standalone):
    assert widgets.text("t", "hi") == "hi"
    assert widgets.number("n") == 0
    assert widgets.dropdown("d", "b", ["a", "b"]) == "b"
    assert widgets.multiselect("m", ["b", "a"], ["a", "b", "c"]) == ["a", "b"]
    assert widgets.checkbox("c") is False
    assert widgets.date("dt") is None
    assert widgets.date("dt2", "2024-03-05") == dt.date(2024, 3, 5)
    assert widgets.get("d") == "b"
    assert widgets.params()["t"] == "hi"
    with pytest.raises(ValueError, match="not defined"):
        widgets.get("nope")


def test_env_vars_set_widgets_outside_the_studio(standalone, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("WORKHOUSE_PARAM_N", "7")
    monkeypatch.setenv("WORKHOUSE_PARAM_REGION", "south")
    monkeypatch.setenv("WORKHOUSE_PARAM_TAGS", "x, z")
    monkeypatch.setenv("WORKHOUSE_PARAM_FLAG", "yes")
    monkeypatch.setenv("WORKHOUSE_PARAM_DAY", "2025-01-31")
    monkeypatch.setenv("WORKHOUSE_PARAM_BAD", "oops")
    monkeypatch.setenv("WORKHOUSE_PARAM_RAW", "from-env")
    assert widgets.number("n", 1) == 7 and isinstance(widgets.get("n"), int)
    assert widgets.dropdown("region", "north", ["north", "south"]) == "south"
    assert widgets.multiselect("tags", [], ["x", "y", "z"]) == ["x", "z"]
    assert widgets.checkbox("flag") is True
    assert widgets.date("day") == dt.date(2025, 1, 31)
    assert widgets.number("bad", 3) == 3  # an invalid value falls back to the default
    assert widgets.get("raw") == "from-env"  # not defined: the raw variable


def test_coercion_and_validation(standalone):
    widgets.number("n", 5, min=0, max=10, step=1)
    reg = widgets.active()
    assert reg.set("n", "7") == 7
    assert reg.set("n", 99) == 10  # clamped
    with pytest.raises(ValueError):
        reg.set("n", "many")
    with pytest.raises(ValueError):
        reg.set("n", True)
    widgets.number("f", 0.5)
    assert reg.set("f", "2") == 2.0
    widgets.dropdown("d", "a", ["a", "b"])
    assert reg.set("d", "b") == "b"
    with pytest.raises(ValueError, match="choices"):
        reg.set("d", "z")
    widgets.dropdown("k", 2, [1, 2, 3])
    assert reg.set("k", "3") == 3  # matched by text, the choice's own type comes back
    widgets.multiselect("m", [], ["a", "b", "c"])
    assert reg.set("m", ["c", "a"]) == ["a", "c"]
    with pytest.raises(ValueError):
        reg.set("m", ["a", "z"])
    widgets.checkbox("c")
    assert reg.set("c", "false") is False and reg.set("c", 1) is True
    widgets.date("day")
    assert reg.set("day", "2024-02-29") == dt.date(2024, 2, 29)
    assert reg.set("day", "") is None
    with pytest.raises(ValueError):
        reg.set("day", "yesterday")
    with pytest.raises(ValueError, match="not defined"):
        reg.set("ghost", 1)


def test_definition_errors(standalone):
    for bad in ("", "1a", "a-b", "a b"):
        with pytest.raises(ValueError, match="invalid widget name"):
            widgets.text(bad)
    with pytest.raises(ValueError, match="choices"):
        widgets.dropdown("d", "z", ["a"])
    with pytest.raises(ValueError, match="empty"):
        widgets.dropdown("d", "a", [])
    with pytest.raises(ValueError):
        widgets.number("n", "x")  # type: ignore[arg-type]


def test_redefinition_keeps_a_valid_value_and_remove(standalone):
    widgets.dropdown("d", "a", ["a", "b"])
    widgets.active().set("d", "b")
    assert widgets.dropdown("d", "a", ["a", "b", "c"]) == "b"  # values survive re-runs
    assert widgets.dropdown("d", "a", ["a", "c"]) == "a"  # no longer valid: the default
    widgets.remove("d")
    with pytest.raises(ValueError):
        widgets.get("d")
    widgets.text("x")
    widgets.remove_all()
    assert widgets.params() == {}


# -- analysis --------------------------------------------------------------------


def cell(code: str, kind: str = "python", output: str | None = None) -> Cell:
    return Cell("c", kind, code, output=output)  # type: ignore[arg-type]


def test_analysis_detects_widget_calls():
    a = analyze(cell('region = wh.widgets.dropdown("region", "a", ["a"])\nn = widgets.get("n")\nprint(wh.widgets.get(name="m"))'))
    assert a.widget_defs == {"region"}
    assert a.widgets == {"region", "n", "m"}
    assert analyze(cell("x = 1")).widgets == frozenset()
    assert analyze(cell('other.get("x")')).widgets == frozenset()
    # a name that is not a literal, or params(), stands for any widget
    assert analyze(cell("wh.widgets.text(name)")).widgets == {"*"}
    assert analyze(cell("p = wh.widgets.params()")).widgets == {"*"}


def test_sql_placeholders_add_widget_dependencies():
    q = "select * from sales where grp = :grp and region = ':not' and amount > :min -- :ignored\n and id::int > 0"
    assert sql_placeholders(q) == ["grp", "min"]
    assert analyze(cell(q, "sql", "df")).widgets == {"grp", "min"}
    assert analyze(cell("select 1", "sql", "df")).widgets == frozenset()


def test_graph_finds_widget_readers():
    cells = [
        Cell("def", "python", 'v = wh.widgets.text("v")'),
        Cell("use", "python", 'print(wh.widgets.get("v"))'),
        Cell("q", "sql", "select :v", output="q"),
        Cell("other", "python", "y = 1"),
        Cell("dyn", "python", "wh.widgets.get(k)"),
    ]
    assert DependencyGraph(cells).widget_readers("v") == ["def", "use", "q", "dyn"]


# -- SQL cell code ---------------------------------------------------------------


def test_sql_cell_with_placeholders_round_trips():
    code = sql_source("top", "select * from sales where grp = :grp", ["recent"])
    assert "params=wh.widgets.params()," in code
    assert detect_sql(code) == ("select * from sales where grp = :grp", "top")
    ast.parse(code)
    plain = sql_source("top", "select 1", [])
    assert "params" not in plain and detect_sql(plain) == ("select 1", "top")


def test_notebook_with_placeholder_cell_serializes_and_parses(tmp_path: Path):
    nb = marimo_io.new_notebook(tmp_path / "n.py")
    nb.cells.append(Cell("w", "python", 'grp = wh.widgets.number("grp", 1)'))
    nb.cells.append(Cell("q", "sql", "select * from sales where grp = :grp", output="df"))
    text = marimo_io.serialize(nb)
    assert "params=wh.widgets.params()" in text
    ast.parse(text)
    back = marimo_io.parse(text, tmp_path / "n.py")
    q = back.cell("q")
    assert q.kind == "sql" and q.code == "select * from sales where grp = :grp" and q.output == "df"
    assert marimo_io.serialize(back) == text


# -- the kernel ------------------------------------------------------------------


def widget_cells() -> list[dict[str, Any]]:
    return [
        SETUP,
        py("w", 'n = wh.widgets.number("n", 2, min=0, max=100)\nregion = wh.widgets.dropdown("region", "north", ["north", "south"])'),
        py("a", 'print("a", wh.widgets.get("n"))\na_val = wh.widgets.get("n") * 10\na_val'),
        py("b", "b_val = a_val + 1\nb_val"),
        py("c", 'c_val = wh.widgets.get("region")\nc_val'),
        py("free", "free = 5\nfree"),
    ]


def last_widgets(rec: Recorder) -> dict[str, Any]:
    return [d for e, d in rec.events if e == "widgets.changed"][-1]


def test_cells_define_widgets_and_the_client_hears_of_them(session: KernelSession):
    session.notebook.create("notebooks/w1.py")
    _, rec = run(session, widget_cells())
    changed = last_widgets(rec)
    defs = {d["name"]: d for d in changed["definitions"]}
    assert set(defs) == {"n", "region"}
    assert defs["n"]["kind"] == "number" and defs["n"]["min"] == 0 and defs["n"]["max"] == 100 and defs["n"]["default"] == 2
    assert defs["region"]["choices"] == ["north", "south"] and defs["region"]["label"] == "region"
    assert changed["values"] == {"n": 2, "region": "north"}
    assert session.notebook.view()["widgets"] == changed
    # a run that changes nothing announces nothing
    _, rec2 = run(session, widget_cells(), ["free"])
    assert not [e for e, _ in rec2.events if e == "widgets.changed"]


def test_widgets_set_reruns_only_dependents(session: KernelSession):
    session.notebook.create("notebooks/w2.py")
    run(session, widget_cells())
    rec = Recorder()
    result = session.handlers()["widgets.set"]({"notebook": "notebooks/w2.py", "name": "n", "value": "5"}, rec)
    # the defining cell, the reader and its descendant; not the region reader nor the free cell
    assert result["ran"] == ["w", "a", "b"] and result["interrupted"] is False
    states = session.notebook.view()["states"]
    assert states["b"]["output"]["text"] == "51"
    assert states["a"]["output"]["text"] == "50"
    assert rec.states("c") == [] and rec.states("free") == []
    events = [e for e, _ in rec.events]
    assert events.index("widgets.changed") < events.index("cell.state")  # the new value is announced first
    assert last_widgets(rec)["values"] == {"n": 5, "region": "north"}
    # the value survives the defining cell running again
    run(session, widget_cells(), ["w"])
    assert session.notebook.widgets.get("n") == 5
    # region only touches its reader
    result = session.handlers()["widgets.set"]({"name": "region", "value": "south"}, Recorder())
    assert result["ran"] == ["w", "c"]
    assert session.notebook.view()["states"]["c"]["output"]["text"] == "'south'"


def test_widgets_set_validates(session: KernelSession):
    session.notebook.create("notebooks/w3.py")
    run(session, widget_cells())
    set_ = session.handlers()["widgets.set"]
    with pytest.raises(ValueError, match="choices"):
        set_({"name": "region", "value": "west"}, Recorder())
    with pytest.raises(ValueError, match="not defined"):
        set_({"name": "ghost", "value": 1}, Recorder())
    with pytest.raises(ValueError, match="not the open notebook"):
        set_({"notebook": "notebooks/other.py", "name": "n", "value": 1}, Recorder())
    assert session.notebook.widgets.get("n") == 2


def test_set_without_readers_only_stores(session: KernelSession):
    session.notebook.create("notebooks/w4.py")
    run(session, [SETUP, py("w", 'v = wh.widgets.text("v", "x")')], None)
    rec = Recorder()
    # the defining cell counts as a reader, so it runs and returns the new value
    assert session.notebook.set_widget("v", "y", None, rec)["ran"] == ["w"]
    run(session, [SETUP, py("w", 'wh.widgets.text("v", "x")')], None)
    session.notebook.widgets.remove("v")
    with pytest.raises(ValueError):
        session.notebook.set_widget("v", "z", None, rec)


def test_deleted_cells_widgets_disappear(session: KernelSession):
    session.notebook.create("notebooks/w5.py")
    cells = widget_cells()
    run(session, cells)
    cells = [c for c in cells if c["id"] != "w"]
    rec = Recorder()
    session.notebook.run(cells, ["free"], rec)
    assert last_widgets(rec) == {"definitions": [], "values": {}}


def test_edited_cell_drops_the_widget_it_no_longer_defines(session: KernelSession):
    session.notebook.create("notebooks/w6.py")
    cells = [SETUP, py("w", 'a = wh.widgets.text("a", "1")\nb = wh.widgets.text("b", "2")')]
    run(session, cells)
    cells[1] = py("w", 'a = wh.widgets.text("a", "1")')
    _, rec = run(session, cells, ["w"])
    assert [d["name"] for d in last_widgets(rec)["definitions"]] == ["a"]


def test_restart_keeps_values_through_preset(session: KernelSession, workspace: Path):
    """The Studio hands the values back when it reopens the notebook in a new kernel."""
    session.notebook.create("notebooks/w7.py")
    run(session, widget_cells())
    session.notebook.set_widget("n", 9, None, Recorder())
    saved = session.notebook.view()["widgets"]["values"]
    source = session.notebook.save(widget_cells(), persist=False)["source"]
    fresh = KernelSession(workspace)
    fresh.notebook.open("notebooks/w7.py", source, saved)
    fresh.notebook.run(None, None, Recorder())
    assert fresh.notebook.widgets.get("n") == 9


# -- jobs ------------------------------------------------------------------------


def job_source(workspace: Path) -> str:
    nb = marimo_io.new_notebook(workspace / "notebooks" / "job.py")
    nb.cells += [
        Cell("w", "python", 'n = wh.widgets.number("n", 1)\nregion = wh.widgets.dropdown("region", "north", ["north", "south"])'),
        Cell("p", "python", 'print(f"n={n} region={region} tags={wh.widgets.multiselect(\'tags\', [], [\'x\', \'y\'])}")'),
    ]
    return marimo_io.serialize(nb)


def test_job_presets_apply_before_the_run(session: KernelSession, workspace: Path):
    rec = Recorder()
    session.handlers()["notebook.open"](
        {"path": "notebooks/job.py", "source": job_source(workspace), "widgets": {"n": "5", "region": "south", "tags": "y", "unknown": "z", "bad name": 1}},
        rec,
    )
    result = session.handlers()["notebook.run"]({"cells": None, "cell_ids": None}, rec)
    assert not result["interrupted"]
    assert rec.streams("p") == "n=5 region=south tags=['y']\n"
    assert last_widgets(rec)["values"] == {"n": 5, "region": "south", "tags": ["y"]}


def test_invalid_presets_fall_back_to_defaults(session: KernelSession, workspace: Path):
    session.notebook.open("notebooks/job.py", job_source(workspace), {"n": "lots", "region": "west"})
    rec = Recorder()
    session.notebook.run(None, None, rec)
    assert rec.streams("p") == "n=1 region=north tags=[]\n"


def test_presets_apply_to_the_notebook_already_open(session: KernelSession, workspace: Path):
    source = job_source(workspace)
    session.notebook.open("notebooks/job.py", source)
    session.notebook.run(None, None, Recorder())
    session.notebook.open("notebooks/job.py", source, {"n": 8})
    assert session.notebook.widgets.get("n") == 8


# -- SQL ---------------------------------------------------------------------------


@pytest.mark.skipif(not PARAMS_SUPPORTED, reason="Workspace.sql(params=...) is not available yet")
def test_sql_cell_binds_widget_values(session: KernelSession):
    session.notebook.create("notebooks/w8.py")
    cells = [
        SETUP,
        py("w", 'grp = wh.widgets.number("grp", 1, min=0, max=6)'),
        sql("q", "select count(*) as n from sales where grp = :grp", "q"),
    ]
    run(session, cells)
    states = session.notebook.view()["states"]
    assert states["q"]["status"] == "done", states["q"]["output"]
    first = session.notebook.values["q"].to_arrow().column("n")[0].as_py()
    assert first == len([i for i in range(1000) if i % 7 == 1])
    result = session.notebook.set_widget("grp", 3, None, Recorder())
    assert result["ran"] == ["w", "q"]
    assert session.notebook.values["q"].to_arrow().column("n")[0].as_py() == len([i for i in range(1000) if i % 7 == 3])
