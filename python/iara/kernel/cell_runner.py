"""Run a single cell (Python, SQL or markdown) and produce its output."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from iara import widgets
from iara.kernel.analyze import analyzed_node
from iara.kernel.history import History, io_of, take_writes
from iara.kernel.notebook.analysis import WORKSPACE_VAR, sql_placeholders
from iara.kernel.notebook.graph import CellDeps
from iara.kernel.notebook.model import Cell
from iara.kernel.runtime.capture import capture
from iara.kernel.runtime.display import display, error_output, frames_of, preview_output, run_query
from iara.kernel.runtime.executor import run_python
from iara.kernel.runtime.interrupt import Interruptor
from iara.kernel.runtime.progress import watch
from iara.kernel.runtime.results import ResultStore
from iara.workspaces import Workspace

Emit = Callable[[str, dict[str, Any]], None]


@dataclass
class Outcome:
    status: str  # done | error | cancelled
    output: dict[str, Any] | None = None
    defs: dict[str, Any] = field(default_factory=dict)
    elapsed_ms: float = 0.0
    #: the frames the cell made (see ``display.frame_info``)
    frames: list[dict[str, Any]] = field(default_factory=list)
    #: the engine queries the cell ran, with their plans (``analyze.analyze_query`` shape)
    queries: list[dict[str, Any]] = field(default_factory=list)


#: queries kept per cell (a loop of small queries must not bloat the cell's state)
MAX_QUERIES = 10
#: previews shown per cell (the last ones)
MAX_PREVIEWS = 10


def is_cancellation(exc: BaseException) -> bool:
    import iara as ia

    return isinstance(exc, (KeyboardInterrupt, ia.QueryCancelled))


def take_plans() -> list[dict[str, Any]]:
    """The engine's query runs recorded since the last call (none if the engine does not record them)."""
    import iara as ia

    take = getattr(ia, "take_recorded_plans", None)
    return take() if take else []


def queries_of(cell: Cell, runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The given query runs as ``QueryAnalysis`` dicts: the last ``MAX_QUERIES``."""
    code = cell.code if cell.kind == "sql" else ""
    now = int(time.time() * 1000)
    out = []
    for p in runs[-MAX_QUERIES:]:
        q = {
            "query": code,
            "at": now,
            "rows": p["rows"],
            "plan": analyzed_node(p["plan"]),
            "text": p["text"],
            "profile": p["profile"],
        }
        if p.get("requests") is not None:  # only when the engine reports them, as the type says
            q["requests"] = p["requests"]
        out.append(q)
    return out


class CellRunner:
    def __init__(self, ws: Workspace, results: ResultStore, history: History, interruptor: Interruptor) -> None:
        self.ws = ws
        self.results = results
        self.history = history
        self.interruptor = interruptor
        self.last_params: dict[str, Any] | None = None

    # -- SQL -----------------------------------------------------------------
    def query(
        self,
        ws: Workspace,
        sql: str,
        tables: dict[str, Any],
        label: str,
        params: dict[str, Any] | None = None,
        allow: list[str] | None = None,
    ) -> tuple[dict[str, Any], Any]:
        """Run a query with its profile and plan: ``(table output, DataFrame)``."""
        # params and allow go in only when given, so a query without them runs as ever
        bound = {"params": params} if params else {}
        if allow is not None:  # [] grants nothing, so test None, not truthiness
            bound["allow"] = allow
        return run_query(self.results, ws.sql(sql, **bound, **tables), label)

    def _sql(self, cell: Cell, deps: CellDeps, inputs: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
        ws = inputs.get(WORKSPACE_VAR)
        ws = ws if isinstance(ws, Workspace) else self.ws
        tables = {r: inputs[r] for r in deps.refs if r != WORKSPACE_VAR and r in inputs}
        # ``:name`` placeholders take the notebook's widget values
        self.last_params = widgets.active().params(sql_placeholders(cell.code)) or None
        output, df = self.query(ws, cell.code, tables, cell.output or "result", self.last_params)
        self.last_frames = frames_of({cell.output: df} if cell.output else {})
        return output, ({cell.output: df} if cell.output else {})

    # -- Python --------------------------------------------------------------
    def _python(self, cell: Cell, defs: frozenset[str], inputs: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
        import iara as ia

        filename = f"<cell {cell.id}>"
        label = cell.name if cell.name != "_" else "value"
        # `preview(frame)` in the cell: its calls are the cell's output (several: one tab each)
        previews: list[tuple[Any, int]] = []
        token = ia._preview_sink.set(lambda frame, n: previews.append((frame, n)))
        try:
            res = run_python(cell.code, inputs, defs, filename)
        finally:
            ia._preview_sink.reset(token)
        if res.error is not None:
            raise _UserError(res.error, filename)
        self.last_frames = frames_of(res.defs, res.value)
        if len(previews) == 1:
            frame, n = previews[0]
            return preview_output(self.results, frame, label, n), res.defs
        if previews:
            names = {id(v): k for k, v in {**inputs, **res.defs}.items() if not k.startswith("_")}
            tables = []
            for frame, n in previews[-MAX_PREVIEWS:]:
                name = names.get(id(frame))
                out = preview_output(self.results, frame, name or label, n)
                if out is not None and out["type"] == "table":
                    tables.append({**out, "name": name} if name else out)
            return ({"type": "tables", "tables": tables} if tables else None), res.defs
        return display(res.value, self.results, label), res.defs

    # -- history -------------------------------------------------------------
    def _record(self, cell: Cell, source: str, runs: list[dict[str, Any]], output: dict[str, Any] | None, elapsed_ms: float, error: str | None) -> None:
        """One history entry for the run: every SQL cell, a Python cell only when it read or wrote tables."""
        profile = output.get("profile") if isinstance(output, dict) else None
        reads, writes = io_of(self.ws, runs, profile)
        if cell.kind == "sql":
            is_table = isinstance(output, dict) and output.get("type") == "table"
            rows = output["result"]["num_rows"] if is_table else None
            # a statement that writes returns a summary: its profile times that summary, not the write
            ms = profile["elapsed_ms"] if is_table and profile and not writes else elapsed_ms
            self.history.record(cell.code, source, ms, rows, error, self.last_params, profile=profile, reads=reads, writes=writes)
        elif reads or writes:
            self.history.record(cell.code, source, elapsed_ms, None, error, kind="python", profile=profile, reads=reads, writes=writes)

    # -- any cell ------------------------------------------------------------
    def run(self, cell: Cell, deps: CellDeps, defs: frozenset[str], inputs: dict[str, Any], emit: Emit, source: str) -> Outcome:
        if cell.kind == "markdown":
            return Outcome("done", {"type": "markdown", "text": cell.code})

        def stream(name: str, text: str) -> None:
            emit("cell.stream", {"cell_id": cell.id, "stream": name, "text": text})

        def progress(queries: list[dict[str, Any]]) -> None:
            emit("progress", {"cell_id": cell.id, "queries": queries})

        t0 = time.perf_counter()
        self.last_frames: list[dict[str, Any]] = []
        self.last_params = None
        take_plans()  # runs and writes left over from earlier cells are not this cell's
        take_writes()
        try:
            with capture(stream), watch(progress), self.interruptor.interruptible():
                if cell.kind == "sql":
                    output, values = self._sql(cell, deps, inputs)
                else:
                    output, values = self._python(cell, defs, inputs)
        except BaseException as e:  # noqa: BLE001
            elapsed = (time.perf_counter() - t0) * 1000
            exc, filename = (e.exc, e.filename) if isinstance(e, _UserError) else (e, None)
            runs = take_plans()
            self._record(cell, source, runs, None, elapsed, f"{type(exc).__name__}: {exc}")
            if is_cancellation(exc):
                # the user stopped it: not an error, so no traceback (the Studio says it was stopped)
                return Outcome("cancelled", None, elapsed_ms=elapsed, queries=queries_of(cell, runs))
            return Outcome("error", error_output(exc, filename), elapsed_ms=elapsed, queries=queries_of(cell, runs))
        elapsed = (time.perf_counter() - t0) * 1000
        runs = take_plans()
        self._record(cell, source, runs, output, elapsed, None)
        return Outcome("done", output, values, elapsed, self.last_frames, queries=queries_of(cell, runs))


class _UserError(Exception):
    """An exception raised by user code, with the cell's code filename."""

    def __init__(self, exc: BaseException, filename: str) -> None:
        super().__init__(str(exc))
        self.exc = exc
        self.filename = filename
