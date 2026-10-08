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

from workhouse.kernel import PROTOCOL_VERSION, catalog
from workhouse.kernel.assist.service import AssistService
from workhouse.kernel.cell_runner import CellRunner, Emit
from workhouse.kernel.history import History
from workhouse.kernel.notebook_service import NotebookService, resolve_in
from workhouse.kernel.runtime.interrupt import Interruptor
from workhouse.kernel.runtime.results import ResultStore
from workhouse.workspaces import Workspace, add_table, load, parse_config, set_active

Handler = Callable[[dict[str, Any], Emit], Any]

#: methods that run user code or mutate the notebook: executed one at a time
#: on the worker thread (everything else answers immediately)
QUEUED = frozenset(
    {"workspace.configure", "notebook.open", "notebook.create", "notebook.run", "sql.run", "catalog.preview", "catalog.add"}
)
#: code assistance: answered on their own thread, newest request per
#: (method, cell) first (an older pending one is answered with null)
ASSIST = frozenset({"assist.complete", "assist.signature", "assist.lint"})


#: largest chunk returned by ``file.read``
MAX_READ = 4 << 20


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

    # -- workspace -----------------------------------------------------------
    def info(self) -> dict[str, Any]:
        import workhouse as wh

        return {
            "protocol": PROTOCOL_VERSION,
            "version": wh.__version__,
            "pid": os.getpid(),
            "host": socket.gethostname(),
            "platform": f"{platform.system()} {platform.machine()}",
            "root": str(self.ws.root),
            "name": self.ws.name,
            "tables": catalog.list_tables(self.ws),
        }

    def _adopt(self, fresh: Workspace) -> dict[str, Any]:
        """Take a new catalog (the same object stays shared by every service)."""
        self.ws.name, self.ws.tables, self.ws.storage, self.ws._session = fresh.name, fresh.tables, fresh.storage, None
        return self.info()

    def reload(self) -> dict[str, Any]:
        return self._adopt(load(self.ws.root))

    def configure(self, toml: str | None) -> dict[str, Any]:
        """The catalog from the Studio's ``workhouse.toml`` text (None: none)."""
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

    # -- SQL editor ----------------------------------------------------------
    def sql_run(self, p: dict[str, Any], emit: Emit) -> dict[str, Any]:
        from workhouse.kernel.runtime.progress import watch

        query = p["query"]
        with watch(lambda q: emit("progress", {"queries": q})), self.interruptor.interruptible():
            output, _ = self.runner.query(self.ws, query, {}, "query", p.get("source", "sql editor"))
        return output

    def sql_explain(self, query: str) -> dict[str, Any]:
        lf = self.ws.sql(query)
        return {"plan": lf.explain_tree(), "text": lf.explain()}

    def preview(self, name: str, limit: int) -> dict[str, Any]:
        df = self.ws.table(name).limit(limit).collect()
        return {"type": "table", "result": self.results.put(df.to_arrow(), name)}

    def handlers(self) -> dict[str, Handler]:
        nb = self.notebook
        return {
            "ping": lambda p, e: self.info(),
            "workspace.info": lambda p, e: self.info(),
            "workspace.reload": lambda p, e: self.reload(),
            "workspace.configure": lambda p, e: self.configure(p.get("toml")),
            "notebook.open": lambda p, e: nb.open(p["path"], p.get("source")),
            "notebook.create": lambda p, e: nb.create(p["path"], bool(p.get("persist", True))),
            "notebook.view": lambda p, e: nb.view(),
            "notebook.rename": lambda p, e: nb.rename(p["path"]),
            "notebook.save": lambda p, e: nb.save(p.get("cells"), bool(p.get("persist", True))),
            "notebook.run": lambda p, e: nb.run(p.get("cells"), p.get("cell_ids"), e),
            "notebook.variables": lambda p, e: nb.variables(),
            "assist.complete": lambda p, e: self.assist.complete(p),
            "assist.signature": lambda p, e: self.assist.signature(p),
            "assist.lint": lambda p, e: self.assist.lint(p),
            "interrupt": lambda p, e: {"interrupted": self.interruptor.interrupt()},
            "result.page": lambda p, e: self.results.page(p["result_id"], p.get("offset", 0), p.get("limit", 100), p.get("sort")),
            "result.export": lambda p, e: self.export(p),
            "file.read": lambda p, e: self.read_file(p),
            "catalog.list": lambda p, e: catalog.list_tables(self.ws),
            "catalog.table": lambda p, e: catalog.table_info(self.ws, p["name"]),
            "catalog.schema": lambda p, e: catalog.schemas(self.ws),
            "catalog.preview": lambda p, e: self.preview(p["name"], int(p.get("limit", 100))),
            "catalog.add": lambda p, e: self.add_table(p),
            "sql.run": self.sql_run,
            "sql.explain": lambda p, e: self.sql_explain(p["query"]),
            "history.list": lambda p, e: self.history.recent(int(p.get("limit", 200))),
        }
