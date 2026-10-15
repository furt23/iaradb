"""Kernel session: reactive execution, outputs, interrupts, results, catalog."""

from __future__ import annotations

import base64

import os
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from workhouse.kernel.notebook import marimo_io
from workhouse.kernel.notebook.model import Cell
from workhouse.kernel.session import KernelSession


class Recorder:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, event: str, data: dict[str, Any]) -> None:
        self.events.append((event, data))

    def states(self, cell_id: str) -> list[str]:
        return [d["status"] for e, d in self.events if e == "cell.state" and d["cell_id"] == cell_id]

    def streams(self, cell_id: str) -> str:
        return "".join(d["text"] for e, d in self.events if e == "cell.stream" and d["cell_id"] == cell_id)


@pytest.fixture()
def session(workspace: Path):
    cwd = os.getcwd()
    s = KernelSession(workspace)
    yield s
    os.chdir(cwd)


def py(cid: str, code: str) -> dict[str, Any]:
    return {"id": cid, "kind": "python", "code": code}


def sql(cid: str, code: str, output: str | None = None) -> dict[str, Any]:
    return {"id": cid, "kind": "sql", "code": code, "output": output}


SETUP = py("setup", "import workhouse as wh\nws = wh.workspace()")


def run(session: KernelSession, cells: list[dict], targets: list[str] | None = None, autorun: bool = False) -> tuple[dict, Recorder]:
    rec = Recorder()
    result = session.notebook.run(cells, targets, rec, autorun)
    return result, rec


def test_create_open_and_save(session: KernelSession, workspace: Path):
    view = session.notebook.create("notebooks/a.py")
    assert view["path"] == "notebooks/a.py" and len(view["cells"]) == 1
    cells = view["cells"] + [sql("q", "select count(*) as n from sales", "n")]
    session.notebook.save(cells)
    text = (workspace / "notebooks" / "a.py").read_text()
    assert "n = ws.sql(" in text and "select count(*) as n from sales" in text
    with pytest.raises(FileExistsError):
        session.notebook.create("notebooks/a.py")
    with pytest.raises(PermissionError):
        session.notebook.open("../outside.py")


def test_python_and_sql_cells_share_values(session: KernelSession):
    session.notebook.create("notebooks/b.py")
    cells = [
        SETUP,
        py("big", "big = ws.sql('select * from sales where amount > 400').collect()"),
        sql("agg", "select grp, count(*) as c from big join regions using (grp) group by grp order by grp", "agg"),
        py("show", "print('groups:', agg.height)\nagg.height * 10"),
    ]
    result, rec = run(session, cells, ["show"])
    assert result == {"ran": ["setup", "big", "agg", "show"], "interrupted": False}
    states = session.notebook.view()["states"]
    assert all(states[c]["status"] == "done" for c in ("setup", "big", "agg", "show"))
    out = states["agg"]["output"]
    assert out["type"] == "table" and out["result"]["num_rows"] == 4
    assert out["profile"]["pipelines"] and out["plan"]["name"]
    assert states["show"]["output"] == {"type": "text", "text": "40"}
    assert rec.streams("show") == "groups: 4\n"
    assert rec.states("show") == ["queued", "running", "done"]


def test_a_rerun_marks_dependents_stale_without_running_them(session: KernelSession):
    session.notebook.create("notebooks/c0.py")
    cells = [py("a", "a = 1"), py("b", "b = a + 1\nb"), py("c", "c = 100\nc")]
    run(session, cells)
    cells[0] = py("a", "a = 10")
    result, rec = run(session, cells, ["a"])
    assert result["ran"] == ["a"]
    states = session.notebook.view()["states"]
    assert states["b"]["stale"] and states["b"]["output"]["text"] == "2" and not states["c"]["stale"]
    assert rec.states("b") == ["done"]  # the client hears that b went stale
    # running b reads a's new value and clears its stale mark
    result, _ = run(session, cells, ["b"])
    assert result["ran"] == ["b"] and not session.notebook.view()["states"]["b"]["stale"]
    assert session.notebook.view()["states"]["b"]["output"]["text"] == "11"


def test_with_autorun_a_rerun_runs_its_dependents(session: KernelSession):
    session.notebook.create("notebooks/c.py")
    cells = [py("a", "a = 1"), py("b", "b = a + 1\nb"), py("c", "c = 100\nc")]
    run(session, cells)
    cells[0] = py("a", "a = 10")
    result, _ = run(session, cells, ["a"], autorun=True)
    assert result["ran"] == ["a", "b"]
    assert session.notebook.view()["states"]["b"]["output"]["text"] == "11"


def test_inputs_run_first_only_when_they_have_no_value(session: KernelSession):
    session.notebook.create("notebooks/d0.py")
    cells = [py("a", "a = 1"), py("b", "b = a * 2\nb")]
    # a never ran: it runs before b
    result, _ = run(session, cells, ["b"])
    assert result["ran"] == ["a", "b"]
    # a edited since: b reads the value a has, nothing else runs
    cells[0] = py("a", "a = 5")
    result, _ = run(session, cells, ["b"])
    assert result["ran"] == ["b"] and session.notebook.view()["states"]["b"]["output"]["text"] == "2"


def test_with_autorun_edited_ancestors_run_first(session: KernelSession):
    session.notebook.create("notebooks/d.py")
    cells = [py("a", "a = 1"), py("b", "b = a * 2\nb")]
    run(session, cells)
    cells[0] = py("a", "a = 5")
    view = session.notebook.view()
    result, _ = run(session, cells, ["b"], autorun=True)
    assert result["ran"] == ["a", "b"]
    assert session.notebook.view()["states"]["b"]["output"]["text"] == "10"
    assert view["states"]["a"]["stale"] is False  # the kernel had not seen the edit yet


def test_errors_block_dependents(session: KernelSession):
    session.notebook.create("notebooks/e.py")
    cells = [py("a", "a = 1 / 0"), py("b", "b = a + 1"), py("r", "print(z)\nz = 1"), py("y", "z = 2")]
    run(session, cells)
    states = session.notebook.view()["states"]
    assert states["a"]["status"] == "error" and states["a"]["output"]["ename"] == "ZeroDivisionError"
    assert "1 / 0" in states["a"]["output"]["traceback"]
    assert states["b"]["output"]["evalue"] == "an upstream cell failed"
    assert "read before the cells that define it" in states["r"]["output"]["evalue"]


def test_cells_redefine_names_and_read_the_nearest_definition_above(session: KernelSession):
    session.notebook.create("notebooks/redef.py")
    cells = [
        py("a", "df = [1, 2, 3, 4]"),
        py("b", "df = [x for x in df if x > 1]"),
        py("c", "n = len(df)"),
        py("d", "df = 'other'"),
        py("e", "m = df"),
    ]
    run(session, cells)
    nb = session.notebook
    assert all(s["status"] == "done" for s in nb.view()["states"].values())
    assert nb.namespace()["n"] == 3 and nb.namespace()["m"] == "other"
    # completions and lint in a cell see the value above it; the Variables panel the last one
    assert nb.namespace("c")["df"] == [2, 3, 4] and nb.namespace()["df"] == "other"
    assert {v["name"]: v["cell_id"] for v in nb.variables()}["df"] == "d"
    # editing the first definition re-runs the cells that read it, not the redefinition below
    cells[0] = py("a", "df = [5, 6]")
    result, _ = run(session, cells, targets=["a"], autorun=True)
    assert result["ran"] == ["a", "b", "c"] and nb.namespace()["n"] == 2


def test_sql_error_has_message_and_history(session: KernelSession):
    session.notebook.create("notebooks/f.py")
    run(session, [SETUP, sql("q", "select nope from sales", "q")])
    out = session.notebook.view()["states"]["q"]["output"]
    assert out["type"] == "error" and "nope" in out["evalue"] and out["traceback"] == ""
    assert session.history.recent(1)[0]["error"]


def _interrupt_soon(session: KernelSession) -> None:
    def go() -> None:
        deadline = time.monotonic() + 10
        while not session.interruptor.busy and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.2)
        session.interruptor.interrupt()

    threading.Thread(target=go, daemon=True).start()


def test_interrupt_python_loop(session: KernelSession):
    session.notebook.create("notebooks/g.py")
    _interrupt_soon(session)
    t0 = time.monotonic()
    result, rec = run(session, [py("loop", "while True:\n    pass"), py("after", "z = 1")])
    assert time.monotonic() - t0 < 5
    assert result["interrupted"] is True and result["ran"] == ["loop"]
    states = session.notebook.view()["states"]
    assert states["loop"]["status"] == "cancelled"
    assert states["after"]["status"] == "idle"


def test_interrupt_query(session: KernelSession):
    session.notebook.create("notebooks/h.py")
    exploding = "select count(*) from sales a join sales b on a.grp = b.grp join sales c on b.grp = c.grp join sales d on c.grp = d.grp"
    _interrupt_soon(session)
    t0 = time.monotonic()
    result, _ = run(session, [SETUP, sql("q", exploding, "q")])
    assert time.monotonic() - t0 < 10
    assert result["interrupted"]
    assert session.notebook.view()["states"]["q"]["output"]["ename"] in ("QueryCancelled", "KeyboardInterrupt")


def test_result_paging_and_sorting(session: KernelSession):
    session.notebook.create("notebooks/i.py")
    run(session, [SETUP, sql("q", "select id, amount from sales", "q")])
    result = session.notebook.view()["states"]["q"]["output"]["result"]
    rid = result["id"]
    # the output shows the first 500 rows; the cell's value has all 1000
    assert result["num_rows"] == 500 and result["truncated"] and result["total_rows"] == 1000
    assert session.notebook.namespace()["q"].height == 1000
    page = session.results.page(rid, 490, 50)
    assert page["total"] == 500 and len(page["rows"]) == 10
    # sorting sorts all the rows, then shows the first
    top = session.results.page(rid, 0, 3, [{"column": "amount", "descending": True}])
    assert [r[0] for r in top["rows"]] == [999, 998, 997]
    # the download has every row
    path = session.export({"result_id": rid, "format": "csv", "name": "sales out"})["path"]
    assert path == "exports/sales_out.csv"
    assert len((session.ws.root / path).read_text().splitlines()) == 1001


def test_frames_show_on_preview_only(session: KernelSession):
    session.notebook.create("notebooks/pv.py")
    cells = [
        SETUP,
        py("lazy", "lf = ws.table('sales')\nlf"),
        py("eager", "df = ws.table('sales').collect()\ndf"),
        py("shown", "big = ws.table('sales')\nbig.preview()"),
        py("few", "ws.table('sales').preview(5)\nx = 1"),
    ]
    run(session, cells)
    states = session.notebook.view()["states"]
    # a frame a cell ends with is not run nor shown: the cell describes its frames instead
    assert states["lazy"]["output"] is None and states["eager"]["output"] is None
    [lf] = states["lazy"]["frames"]
    assert lf["name"] == "lf" and lf["kind"] == "LazyFrame" and lf["rows"] is None
    assert [c["name"] for c in lf["columns"]] == ["id", "grp", "amount"] and lf["columns"][0]["type"] == "Int64"
    [df] = states["eager"]["frames"]
    assert df["kind"] == "DataFrame" and df["rows"] == 1000
    # an unnamed frame a cell ends with, and a SQL cell's result
    [anon] = states["few"]["frames"] if states["few"]["frames"] else [None]
    assert anon is None  # `few` ends with x = 1: no frame
    shown = states["shown"]["output"]
    assert shown["type"] == "table" and shown["result"]["num_rows"] == 500 and shown["result"]["truncated"]
    assert shown["result"]["total_rows"] is None and "profile" in shown and "plan" in shown
    assert states["few"]["output"]["result"]["num_rows"] == 5
    # downloads, charts and the wrangler read all the rows of a lazy preview
    rid = shown["result"]["id"]
    assert session.results.full_table(rid).num_rows == 1000
    path = session.export({"result_id": rid, "format": "parquet", "name": "big"})["path"]
    import pyarrow.parquet as pq

    assert pq.read_table(session.ws.root / path).num_rows == 1000


def test_variables(session: KernelSession):
    session.notebook.create("notebooks/j.py")
    run(session, [SETUP, py("v", "nums = [1, 2, 3]\ndf = ws.table('sales').collect()")])
    names = {v["name"]: v for v in session.notebook.variables()}
    assert names["df"]["summary"] == "1000 × 3" and names["nums"]["type"] == "list"
    assert "wh" not in names  # modules are hidden


def test_catalog(session: KernelSession, workspace: Path):
    assert [t["name"] for t in session.handlers()["catalog.list"]({}, lambda *a: None)] == ["sales", "regions"]
    info = session.handlers()["catalog.table"]({"name": "sales"}, lambda *a: None)
    assert info["num_rows"] == 1000 and info["files"] == 1
    stats = {s["column"]: s for s in info["stats"]}
    assert stats["id"]["min"] == 0 and stats["id"]["max"] == 999
    session.handlers()["catalog.add"]({"name": "sales_copy", "path": "data/sales.parquet"}, lambda *a: None)
    assert "sales_copy" in (workspace / "workhouse.toml").read_text()
    assert session.ws.sql("select count(*) from sales_copy").collect().item() == 1000


def test_scratch_sql_and_explain(session: KernelSession):
    rec = Recorder()
    out = session.sql_run({"query": "select grp, sum(amount) from sales group by grp"}, rec)
    assert out["result"]["num_rows"] == 7 and out["profile"]["elapsed_ms"] >= 0
    plan = session.sql_explain("select * from sales where id < 10")
    assert plan["plan"]["name"] and "Physical plan" in plan["text"]


# -- protocol 2: the Studio owns the files -------------------------------------


def call(session: KernelSession, method: str, params: dict[str, Any]) -> Any:
    return session.handlers()[method](params, lambda *a: None)


def test_configure_replaces_the_catalog(session: KernelSession, workspace: Path):
    toml = '[workspace]\nname = "remote"\n\n[tables.only]\npath = "data/sales.parquet"\n'
    info = call(session, "workspace.configure", {"toml": toml})
    assert info["name"] == "remote" and [t["name"] for t in info["tables"]] == ["only"]
    assert info["host"] and info["platform"]
    assert session.ws.sql("select count(*) from only").collect().item() == 1000
    # notebooks see the kernel's catalog through wh.workspace()
    session.notebook.create("notebooks/cfg.py", persist=False)
    result, _ = run(session, [SETUP, py("t", "names = ws.session.tables()")])
    assert result["ran"] == ["setup", "t"] and session.notebook.namespace()["names"] == ["only"]


def test_notebooks_live_in_the_studio(session: KernelSession, workspace: Path):
    created = call(session, "notebook.create", {"path": "notebooks/s.py", "persist": False})
    assert not (workspace / "notebooks" / "s.py").exists() and "marimo.App" in created["source"]
    cells = created["cells"] + [py("x", "x = 41 + 1")]
    saved = call(session, "notebook.save", {"cells": cells, "persist": False})
    assert saved["path"] == "notebooks/s.py" and "x = 41 + 1" in saved["source"]
    assert not (workspace / "notebooks" / "s.py").exists()
    # another kernel opens it from the source alone
    other = KernelSession(workspace)
    view = call(other, "notebook.open", {"path": "notebooks/s.py", "source": saved["source"]})
    assert [c["code"] for c in view["cells"]][-1] == "x = 41 + 1"


def test_catalog_add_without_writing(session: KernelSession, workspace: Path):
    before = (workspace / "workhouse.toml").read_text()
    ref = call(session, "catalog.add", {"name": "s3t", "path": "s3://bucket/t/", "persist": False})
    assert ref["path"] == "s3://bucket/t/" and '[tables.s3t]\npath = "s3://bucket/t/"' in ref["entry"]
    assert (workspace / "workhouse.toml").read_text() == before
    assert session.ws.spec("s3t") is not None


def test_exports_are_read_in_chunks(session: KernelSession):
    rec = Recorder()
    out = session.sql_run({"query": "select * from sales"}, rec)
    path = call(session, "result.export", {"result_id": out["result"]["id"], "format": "csv", "name": "all"})["path"]
    chunks, offset = [], 0
    while True:
        c = call(session, "file.read", {"path": path, "offset": offset, "length": 4096})
        data = base64.b64decode(c["data"])
        chunks.append(data)
        offset += len(data)
        if c["eof"]:
            break
    assert len(chunks) > 1 and b"".join(chunks) == (session.ws.root / path).read_bytes()
    with pytest.raises(PermissionError):
        call(session, "file.read", {"path": "workhouse.toml"})


def test_renamed_notebook_keeps_its_state(session: KernelSession):
    session.notebook.create("notebooks/before.py", persist=False)
    run(session, [SETUP, py("v", "kept = 42")])
    view = call(session, "notebook.rename", {"path": "notebooks/sub/after.py"})
    assert view["path"] == "notebooks/sub/after.py" and view["states"]["v"]["status"] == "done"
    assert session.notebook.namespace()["kept"] == 42


def test_tables_created_by_sql_reach_the_studio(session: KernelSession, workspace: Path):
    rec = Recorder()
    out = session.handlers()["sql.run"]({"query": "create table big_sales as select * from sales where amount > 100"}, rec)
    assert out["result"]["page"]["rows"][0][0] == "create"
    changes = [d for e, d in rec.events if e == "catalog.changed"]
    assert changes == [{"name": "big_sales", "entry": '\n[tables.big_sales]\npath = "warehouse/big_sales"\nformat = "delta"\n', "kind": "table"}]
    assert (workspace / "warehouse" / "big_sales").is_dir()
    # a notebook cell drops it: the run reports that too
    session.notebook.create("notebooks/drop.py", persist=False)
    rec = Recorder()
    result = session.handlers()["notebook.run"]({"cells": [SETUP, sql("d", "drop table big_sales", "dropped")], "cell_ids": None}, rec)
    assert result["ran"] == ["setup", "d"]
    assert [d for e, d in rec.events if e == "catalog.changed"] == [{"name": "big_sales", "entry": None, "kind": "table"}]


def test_a_notebook_runs_headless_as_opened(session: KernelSession, workspace: Path):
    # what a job does: open the file's notebook, then run it without the editor's cells
    nb = marimo_io.new_notebook(workspace / "notebooks" / "job.py")  # its setup cell defines ws
    nb.cells.append(Cell("b", "sql", "select count(*) as n from sales", output="n"))
    view = call(session, "notebook.open", {"path": "notebooks/job.py", "source": marimo_io.serialize(nb)})
    rec = Recorder()
    result = session.handlers()["notebook.run"]({"cells": None, "cell_ids": None}, rec)
    assert result == {"ran": [c["id"] for c in view["cells"]], "interrupted": False}
    assert rec.states(view["cells"][-1]["id"])[-1] == "done"


def test_the_setup_cell_runs_first_and_its_names_reach_every_cell(session: KernelSession, workspace: Path):
    nb = marimo_io.new_notebook(workspace / "notebooks" / "hidden.py")
    view = call(session, "notebook.open", {"path": "notebooks/hidden.py", "source": marimo_io.serialize(nb)})
    assert [c["id"] for c in view["cells"]] == ["setup"] and view["cells"][0]["setup"]
    cells = [
        view["cells"][0],
        py("p", "n = ws.table('sales').collect().height"),
        sql("s", "select count(*) as k from sales", "k"),
        py("m", "mo.md('x')"),
        py("plain", "x = 1"),
    ]
    everyone = {"setup", "p", "s", "m", "plain"}
    # running a single cell brings the setup cell along, even one that reads none of its names
    result, rec = run(session, cells, ["plain"])
    assert result["ran"][0] == "setup" and "plain" in result["ran"]
    assert rec.states("plain")[-1] == "done"
    # running everything: setup first, then the rest, all done
    result, rec = run(session, cells, None)
    assert result["ran"][0] == "setup" and set(result["ran"]) == everyone
    assert all(rec.states(c)[-1] == "done" for c in everyone)
    assert session.notebook.namespace()["n"] == 1000
    # editing the setup code: with autorun, everything that depends on it reruns
    edited = [{**cells[0], "code": cells[0]["code"] + "\nextra = 1"}, *cells[1:]]
    result, _ = run(session, edited, ["setup"], autorun=True)
    assert result["ran"][0] == "setup" and set(result["ran"]) == everyone - {"plain"}


def test_a_failing_setup_cell_blocks_the_others(session: KernelSession):
    session.notebook.create("notebooks/bad.py", persist=False)
    cells = [{**py("setup", "import nothing_here"), "setup": True}, py("a", "x = 1")]
    result, rec = run(session, cells, ["a"])
    assert result["ran"] == ["setup"]
    assert rec.states("setup")[-1] == "error" and rec.states("a")[-1] == "error"


def test_cells_describe_the_frames_they_make(session: KernelSession):
    session.notebook.create("notebooks/fr.py")
    cells = [SETUP, py("p", "a = ws.table('sales')\n_hidden = a\nn = 3\na.select('id').collect()"), sql("s", "select grp from sales", "g")]
    run(session, cells)
    states = session.notebook.view()["states"]
    assert [(f["name"], f["kind"]) for f in states["p"]["frames"]] == [("a", "LazyFrame"), (None, "DataFrame")]
    assert states["p"]["frames"][1]["columns"] == [{"name": "id", "type": "Int64"}]
    assert [(f["name"], f["rows"]) for f in states["s"]["frames"]] == [("g", 1000)]
