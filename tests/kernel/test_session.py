"""Kernel session: reactive execution, outputs, interrupts, results, catalog."""

from __future__ import annotations

import base64

import os
import threading
import time
from pathlib import Path
from typing import Any

import pytest

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


def run(session: KernelSession, cells: list[dict], targets: list[str] | None = None) -> tuple[dict, Recorder]:
    rec = Recorder()
    result = session.notebook.run(cells, targets, rec)
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


def test_rerun_propagates_to_dependents_only(session: KernelSession):
    session.notebook.create("notebooks/c.py")
    cells = [py("a", "a = 1"), py("b", "b = a + 1\nb"), py("c", "c = 100\nc")]
    run(session, cells)
    cells[0] = py("a", "a = 10")
    result, _ = run(session, cells, ["a"])
    assert result["ran"] == ["a", "b"]
    assert session.notebook.view()["states"]["b"]["output"]["text"] == "11"


def test_stale_ancestors_run_first(session: KernelSession):
    session.notebook.create("notebooks/d.py")
    cells = [py("a", "a = 1"), py("b", "b = a * 2\nb")]
    run(session, cells)
    cells[0] = py("a", "a = 5")
    view = session.notebook.view()
    result, _ = run(session, cells, ["b"])
    assert result["ran"] == ["a", "b"]
    assert session.notebook.view()["states"]["b"]["output"]["text"] == "10"
    assert view["states"]["a"]["stale"] is False  # the kernel had not seen the edit yet


def test_errors_block_dependents(session: KernelSession):
    session.notebook.create("notebooks/e.py")
    cells = [py("a", "a = 1 / 0"), py("b", "b = a + 1"), py("x", "x = 1"), py("y", "x = 2")]
    run(session, cells)
    states = session.notebook.view()["states"]
    assert states["a"]["status"] == "error" and states["a"]["output"]["ename"] == "ZeroDivisionError"
    assert "1 / 0" in states["a"]["output"]["traceback"]
    assert states["b"]["output"]["evalue"] == "an upstream cell failed"
    assert "more than one cell" in states["x"]["output"]["evalue"]


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
    rid = session.notebook.view()["states"]["q"]["output"]["result"]["id"]
    page = session.results.page(rid, 990, 50)
    assert page["total"] == 1000 and len(page["rows"]) == 10
    top = session.results.page(rid, 0, 3, [{"column": "amount", "descending": True}])
    assert [r[0] for r in top["rows"]] == [999, 998, 997]
    path = session.export({"result_id": rid, "format": "csv", "name": "sales out"})["path"]
    assert path == "exports/sales_out.csv"


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
