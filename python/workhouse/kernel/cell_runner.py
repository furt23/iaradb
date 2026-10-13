"""Run a single cell (Python, SQL or markdown) and produce its output."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from workhouse import widgets
from workhouse.kernel.history import History
from workhouse.kernel.notebook.analysis import WORKSPACE_VAR, sql_placeholders
from workhouse.kernel.notebook.graph import CellDeps
from workhouse.kernel.notebook.model import Cell
from workhouse.kernel.runtime.capture import capture
from workhouse.kernel.runtime.display import display, error_output, run_query
from workhouse.kernel.runtime.executor import run_python
from workhouse.kernel.runtime.interrupt import Interruptor
from workhouse.kernel.runtime.progress import watch
from workhouse.kernel.runtime.results import ResultStore
from workhouse.workspaces import Workspace

Emit = Callable[[str, dict[str, Any]], None]


@dataclass
class Outcome:
    status: str  # done | error | cancelled
    output: dict[str, Any] | None = None
    defs: dict[str, Any] = field(default_factory=dict)
    elapsed_ms: float = 0.0


def is_cancellation(exc: BaseException) -> bool:
    import workhouse as wh

    return isinstance(exc, (KeyboardInterrupt, wh.QueryCancelled))


class CellRunner:
    def __init__(self, ws: Workspace, results: ResultStore, history: History, interruptor: Interruptor) -> None:
        self.ws = ws
        self.results = results
        self.history = history
        self.interruptor = interruptor

    # -- SQL -----------------------------------------------------------------
    def query(
        self, ws: Workspace, sql: str, tables: dict[str, Any], label: str, source: str, params: dict[str, Any] | None = None
    ) -> tuple[dict[str, Any], Any]:
        """Run a query with its profile and plan: ``(table output, DataFrame)``."""
        t0 = time.perf_counter()
        # params go in only when given, so a query without them runs as ever
        bound = {"params": params} if params else {}
        try:
            output, df = run_query(self.results, ws.sql(sql, **bound, **tables), label)
        except BaseException as e:
            self.history.record(sql, source, (time.perf_counter() - t0) * 1000, None, f"{type(e).__name__}: {e}", params)
            raise
        self.history.record(sql, source, output["profile"]["elapsed_ms"], df.height, params=params)
        return output, df

    def _sql(self, cell: Cell, deps: CellDeps, inputs: dict[str, Any], source: str) -> tuple[dict[str, Any] | None, dict[str, Any]]:
        ws = inputs.get(WORKSPACE_VAR)
        ws = ws if isinstance(ws, Workspace) else self.ws
        tables = {r: inputs[r] for r in deps.refs if r != WORKSPACE_VAR and r in inputs}
        # ``:name`` placeholders take the notebook's widget values
        params = widgets.active().params(sql_placeholders(cell.code)) or None
        output, df = self.query(ws, cell.code, tables, cell.output or "result", source, params)
        return output, ({cell.output: df} if cell.output else {})

    # -- Python --------------------------------------------------------------
    def _python(self, cell: Cell, defs: frozenset[str], inputs: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
        filename = f"<cell {cell.id}>"
        res = run_python(cell.code, inputs, defs, filename)
        if res.error is not None:
            raise _UserError(res.error, filename)
        return display(res.value, self.results, cell.name if cell.name != "_" else "value"), res.defs

    # -- any cell ------------------------------------------------------------
    def run(self, cell: Cell, deps: CellDeps, defs: frozenset[str], inputs: dict[str, Any], emit: Emit, source: str) -> Outcome:
        if cell.kind == "markdown":
            return Outcome("done", {"type": "markdown", "text": cell.code})

        def stream(name: str, text: str) -> None:
            emit("cell.stream", {"cell_id": cell.id, "stream": name, "text": text})

        def progress(queries: list[dict[str, Any]]) -> None:
            emit("progress", {"cell_id": cell.id, "queries": queries})

        t0 = time.perf_counter()
        try:
            with capture(stream), watch(progress), self.interruptor.interruptible():
                if cell.kind == "sql":
                    output, values = self._sql(cell, deps, inputs, source)
                else:
                    output, values = self._python(cell, defs, inputs)
        except BaseException as e:  # noqa: BLE001
            elapsed = (time.perf_counter() - t0) * 1000
            exc, filename = (e.exc, e.filename) if isinstance(e, _UserError) else (e, None)
            status = "cancelled" if is_cancellation(exc) else "error"
            return Outcome(status, error_output(exc, filename), elapsed_ms=elapsed)
        return Outcome("done", output, values, (time.perf_counter() - t0) * 1000)


class _UserError(Exception):
    """An exception raised by user code, with the cell's code filename."""

    def __init__(self, exc: BaseException, filename: str) -> None:
        super().__init__(str(exc))
        self.exc = exc
        self.filename = filename
