"""Kernel session: the workspace, shared services and the method table."""

from __future__ import annotations

import base64
import os
import platform
import re
import socket
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from iara.kernel import PROTOCOL_VERSION, catalog
from iara.kernel.analyze import analyze_query
from iara.kernel.assist.service import AssistService
from iara.kernel.cell_runner import CellRunner, Emit
from iara.kernel.history import History
from iara.kernel.notebook import marimo_io
from iara.kernel.notebook.model import Cell
from iara.kernel.notebook_service import NotebookService, resolve_in
from iara.kernel.params import bind_params
from iara.kernel.runtime.interrupt import Interruptor
from iara.kernel.runtime.charts import chart_data
from iara.kernel.runtime.results import ResultStore
from iara.workspaces import Workspace, add_table, load, parse_config, set_active

Handler = Callable[[dict[str, Any], Emit], Any]

#: methods that run user code or mutate the notebook: executed one at a time
#: on the worker thread (everything else answers immediately)
QUEUED = frozenset(
    {"workspace.configure", "notebook.open", "notebook.create", "notebook.run", "widgets.set", "sql.run", "sql.analyze", "catalog.preview", "catalog.add"}
)
#: code assistance: answered on their own thread, newest request per
#: (method, cell) first (an older pending one is answered with null)
ASSIST = frozenset({"assist.complete", "assist.signature", "assist.lint"})
#: reads that may take a while (aggregating a large result): answered on a
#: small pool of threads, so the reader stays free for ``interrupt``
BACKGROUND = frozenset({"result.chart", "wrangle.profile"})


#: largest chunk returned by ``file.read``
MAX_READ = 4 << 20


def render_cells(source: str, path: Path, cells: list[dict[str, Any]]) -> str:
    """``source`` with its cells replaced by ``cells``, the rest (app options, header) kept; nothing runs."""
    nb = marimo_io.parse(source, path)
    nb.cells = [Cell.from_view(v) for v in cells]
    return marimo_io.serialize(nb)


class KernelSession:
    def __init__(self, root: str | Path | None = None) -> None:
        self.ws: Workspace = load(root)
        set_active(self.ws)
        os.chdir(self.ws.root)
        self.results = ResultStore()
        self.history = History(self.ws.root)
        self.interruptor = Interruptor()
        self.runner = CellRunner(self.ws, self.results, self.history, self.interruptor)
        self.notebook = NotebookService(self.ws, self.runner)
        self.assist = AssistService(self.ws, self.notebook)
        #: catalog changes made by statements, sent to the Studio after each run
        self.catalog_changes: list[dict[str, Any]] = []
        self.ws.on_catalog_change = self.catalog_changes.append
        # the plans of the queries cells run, for the Studio (see ``cell_runner.queries_of``)
        import iara as ia

        if hasattr(ia, "record_plans"):
            ia.record_plans(True)

    # -- workspace -----------------------------------------------------------
    def info(self) -> dict[str, Any]:
        import iara as ia

        return {
            "protocol": PROTOCOL_VERSION,
            "version": ia.__version__,
            "pid": os.getpid(),
            "host": socket.gethostname(),
            "platform": f"{platform.system()} {platform.machine()}",
            "root": str(self.ws.root),
            "name": self.ws.name,
            "tables": catalog.list_tables(self.ws),
            "schemas": self.ws.schemas,
            "catalogs": self.ws.catalog_names,
        }

    def _adopt(self, fresh: Workspace) -> dict[str, Any]:
        """Take a new catalog (the same object stays shared by every service)."""
        self.ws.name, self.ws.tables, self.ws.storage, self.ws._session = fresh.name, fresh.tables, fresh.storage, None
        self.ws.warehouse, self.ws.declared_schemas = fresh.warehouse, fresh.declared_schemas
        self.ws.schema_locations, self.ws.discovered, self.ws.catalogs = fresh.schema_locations, [], fresh.catalogs
        return self.info()

    def report_catalog(self, emit: Emit) -> None:
        """Tell the Studio (it owns ``iara.toml``) what statements changed."""
        while self.catalog_changes:
            emit("catalog.changed", self.catalog_changes.pop(0))

    def reload(self) -> dict[str, Any]:
        return self._adopt(load(self.ws.root))

    def configure(self, toml: str | None) -> dict[str, Any]:
        """The catalog from the Studio's ``iara.toml`` text (None: none)."""
        return self._adopt(parse_config(toml or "", self.ws.root))

    def add_table(self, p: dict[str, Any]) -> dict[str, Any]:
        persist = bool(p.get("persist", True))
        spec, entry = add_table(self.ws, p["name"], p["path"], p.get("format"), persist=persist)
        return {**catalog.spec_view(self.ws, spec), "entry": entry}

    # -- results -------------------------------------------------------------
    def export(self, p: dict[str, Any]) -> dict[str, Any]:
        fmt = p.get("format", "csv")
        name = re.sub(r"[^A-Za-z0-9_.-]", "_", p.get("name") or f"result-{time.strftime('%Y%m%d-%H%M%S')}")
        path = resolve_in(self.ws.root, f"exports/{name}.{fmt}")
        path.parent.mkdir(parents=True, exist_ok=True)
        self.results.export(p["result_id"], str(path), fmt)
        return {"path": path.relative_to(self.ws.root).as_posix()}

    def read_file(self, p: dict[str, Any]) -> dict[str, Any]:
        """A chunk of an exported file, base64 (downloads from remote kernels)."""
        rel = str(p["path"]).replace(os.sep, "/")
        if not rel.startswith("exports/"):
            raise PermissionError("only exports can be read")
        path = resolve_in(self.ws.root, rel)
        offset, length = int(p.get("offset", 0)), min(int(p.get("length", 1 << 20)), MAX_READ)
        size = path.stat().st_size
        with open(path, "rb") as f:
            f.seek(offset)
            data = f.read(length)
        return {"data": base64.b64encode(data).decode("ascii"), "size": size, "eof": offset + len(data) >= size}

    def run_notebook(self, p: dict[str, Any], emit: Emit) -> dict[str, Any]:
        self.ws.refresh()
        try:
            return self.notebook.run(p.get("cells"), p.get("cell_ids"), emit, bool(p.get("autorun")))
        finally:
            self.report_catalog(emit)

    def set_widget(self, p: dict[str, Any], emit: Emit) -> dict[str, Any]:
        nb = self.notebook.notebook
        if p.get("notebook") is not None and nb is not None and resolve_in(self.ws.root, p["notebook"]) != nb.path:
            raise ValueError(f"{p['notebook']!r} is not the open notebook")
        self.ws.refresh()
        try:
            return self.notebook.set_widget(p["name"], p.get("value"), p.get("cells"), emit)
        finally:
            self.report_catalog(emit)

    # -- SQL editor ----------------------------------------------------------
    def sql_run(self, p: dict[str, Any], emit: Emit) -> dict[str, Any]:
        from iara.kernel.runtime.progress import watch

        query = p["query"]
        allow = p["allow"] if "allow" in p else None  # [] grants nothing, so test the key, not truthiness
        self.ws.refresh()
        try:
            with watch(lambda q: emit("progress", {"queries": q})), self.interruptor.interruptible():
                output, _ = self.runner.query(
                    self.ws, query, {}, "query", p.get("source", "sql editor"), bind_params(p), allow=allow
                )
        finally:
            self.report_catalog(emit)
        return output

    def sql_explain(self, p: dict[str, Any] | str) -> dict[str, Any]:
        """The plan of a query: a request (with ``params`` and ``allow``) or the query text."""
        req = {"query": p} if isinstance(p, str) else p
        params = bind_params(req)
        bound = {"allow": req["allow"]} if "allow" in req else {}  # [] grants nothing: test the key
        lf = self.ws.sql(req["query"], params=params, **bound) if params else self.ws.sql(req["query"], **bound)
        return {"plan": lf.explain_tree(), "text": lf.explain()}

    def preview(self, name: str, limit: int) -> dict[str, Any]:
        df = self.ws.table(name).limit(limit).collect()
        return {"type": "table", "result": self.results.put(df.to_arrow(), name)}

    def wrangle(self, what: str, p: dict[str, Any]) -> dict[str, Any]:
        from iara.kernel import wrangle

        self.ws.refresh()
        with self.interruptor.interruptible():
            if what == "preview":
                return wrangle.preview(self.ws, self.results, p["source"], p.get("steps", []))
            if what == "sql":
                return wrangle.sql(self.ws, self.results, p["source"], p.get("steps", []))
            return wrangle.profile(self.ws, self.results, p["source"], p.get("steps", []), p["column"])

    def handlers(self) -> dict[str, Handler]:
        nb = self.notebook
        return {
            "ping": lambda p, e: self.info(),
            "workspace.info": lambda p, e: self.info(),
            "workspace.reload": lambda p, e: self.reload(),
            "workspace.configure": lambda p, e: self.configure(p.get("toml")),
            "notebook.open": lambda p, e: nb.open(p["path"], p.get("source"), p.get("widgets")),
            "notebook.create": lambda p, e: nb.create(p["path"], bool(p.get("persist", True))),
            "notebook.view": lambda p, e: nb.view(),
            # the cells of a source, parsed and never run (the Studio shows a notebook whose cluster is stopped)
            "notebook.parse": lambda p, e: {"cells": [c.to_view() for c in marimo_io.parse(p["source"], resolve_in(self.ws.root, p["path"])).cells]},
            "notebook.render": lambda p, e: {"source": render_cells(p["source"], resolve_in(self.ws.root, p["path"]), p["cells"])},
            "notebook.template": lambda p, e: {"source": marimo_io.serialize(marimo_io.new_notebook(resolve_in(self.ws.root, p["path"])))},
            "notebook.rename": lambda p, e: nb.rename(p["path"]),
            "notebook.save": lambda p, e: nb.save(p.get("cells"), bool(p.get("persist", True))),
            "notebook.run": self.run_notebook,
            "widgets.set": self.set_widget,
            "notebook.variables": lambda p, e: nb.variables(),
            "notebook.clear": lambda p, e: nb.clear(p["path"], p.get("cells")),
            "assist.complete": lambda p, e: self.assist.complete(p),
            "assist.signature": lambda p, e: self.assist.signature(p),
            "assist.lint": lambda p, e: self.assist.lint(p),
            "interrupt": lambda p, e: {"interrupted": self.interruptor.interrupt()},
            "result.page": lambda p, e: self.results.page(p["result_id"], p.get("offset", 0), p.get("limit", 100), p.get("sort")),
            "result.chart": lambda p, e: chart_data(self.results.full_table(p["result_id"]), p["spec"]),
            "result.export": lambda p, e: self.export(p),
            "file.read": lambda p, e: self.read_file(p),
            "catalog.list": lambda p, e: catalog.list_tables(self.ws),
            "catalog.table": lambda p, e: catalog.table_info(self.ws, p["name"]),
            "catalog.history": lambda p, e: catalog.history(self.ws, p["table"], int(p.get("limit", 50))),
            "catalog.schema": lambda p, e: catalog.schemas(self.ws),
            "catalog.preview": lambda p, e: self.preview(p["name"], int(p.get("limit", 100))),
            "catalog.add": lambda p, e: self.add_table(p),
            "sql.run": self.sql_run,
            "sql.explain": lambda p, e: self.sql_explain(p),
            "sql.analyze": lambda p, e: analyze_query(self.ws, p["query"], self.history, self.interruptor, bind_params(p)),
            "history.list": lambda p, e: self.history.recent(int(p.get("limit", 200))),
            "wrangle.preview": lambda p, e: self.wrangle("preview", p),
            "wrangle.profile": lambda p, e: self.wrangle("profile", p),
            "wrangle.sql": lambda p, e: self.wrangle("sql", p),
        }
