"""The open notebook: its source, cell states, values and execution.

Running a cell runs it, and the cells it reads from that have no value yet
(never ran, or failed). The cells that read its values are marked stale, not
run: nothing runs unless asked. With ``autorun`` (a notebook setting in the
Studio) they run too, as marimo does, and so do edited ancestors. Running
all cells stops at the first cell that fails, as a notebook does; running one
cell or changing a widget goes on, and a failure blocks only the cells that
read from it.

Notebook files belong to the Studio (protocol v2): it sends a notebook's
source when opening it and writes back the source the kernel returns on
create / save (``persist=False``). Kernels on the Studio's machine may still
read and write the files themselves (``persist=True``, the default).
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from iara import widgets
from iara.kernel.cell_runner import CellRunner, Emit, Outcome
from iara.kernel.notebook import marimo_io
from iara.kernel.notebook.graph import DependencyGraph
from iara.kernel.notebook.model import Cell, Notebook
from iara.workspaces import Workspace


@dataclass
class CellState:
    status: str = "idle"  # idle | queued | running | done | error | cancelled
    output: dict[str, Any] | None = None
    streams: list[dict[str, str]] = field(default_factory=list)
    elapsed_ms: float | None = None
    defs: tuple[str, ...] = ()
    #: code of the last run (a cell whose code differs is stale)
    code_run: str | None = None
    #: status before being queued (restored if the run is interrupted)
    prev_status: str = "idle"
    #: a cell it reads from ran since it last ran
    inputs_changed: bool = False
    #: the frames the last run made: name, kind, rows, columns and types
    frames: list[dict[str, Any]] = field(default_factory=list)
    #: the engine queries the last run made, with their plans (see ``cell_runner.queries_of``)
    queries: list[dict[str, Any]] = field(default_factory=list)

    def view(self, code: str) -> dict[str, Any]:
        edited = self.code_run is not None and self.code_run != code
        stale = (edited or self.inputs_changed) and self.status in ("done", "error")
        return {
            "status": self.status,
            "stale": stale,
            "output": self.output,
            "streams": self.streams,
            "elapsed_ms": self.elapsed_ms,
            "frames": self.frames,
            "queries": self.queries,
        }


def resolve_in(root: Path, rel: str) -> Path:
    """``rel`` inside the workspace root (paths escaping it are refused)."""
    p = (root / rel).resolve()
    if p != root and root not in p.parents:
        raise PermissionError(f"{rel!r} is outside the workspace")
    return p


def summarize(value: Any) -> str:
    for attr in ("shape",):
        shape = getattr(value, attr, None)
        if isinstance(shape, tuple):
            return " × ".join(map(str, shape))
    if hasattr(value, "num_rows") and hasattr(value, "num_columns"):
        return f"{value.num_rows} × {value.num_columns}"
    text = repr(value)
    return text if len(text) <= 80 else text[:77] + "..."


class NotebookService:
    def __init__(self, ws: Workspace, runner: CellRunner) -> None:
        self.ws = ws
        self.runner = runner
        self.notebook: Notebook | None = None
        #: the values each cell defined in its last run, by cell (a name may be redefined by later cells)
        self.values: dict[str, dict[str, Any]] = {}
        self.states: dict[str, CellState] = {}
        #: the notebook's widgets (definitions per cell, values): they outlive kernel-side re-adoption of cells
        self.widgets = widgets.Registry()
        widgets.install(self.widgets)
        self._lock = threading.RLock()

    # -- files ---------------------------------------------------------------
    def _require(self) -> Notebook:
        if self.notebook is None:
            raise RuntimeError("no notebook is open")
        return self.notebook

    def view(self) -> dict[str, Any]:
        nb = self._require()
        with self._lock:
            return {
                "path": nb.path.relative_to(self.ws.root).as_posix(),
                "cells": [c.to_view() for c in nb.cells],
                "states": {c.id: self.states.setdefault(c.id, CellState()).view(c.code) for c in nb.cells},
                "widgets": self.widgets.payload(),
            }

    def open(self, rel: str, source: str | None = None, preset: dict[str, Any] | None = None) -> dict[str, Any]:
        """Open a notebook from ``source`` (sent by the Studio) or its file.
        ``preset``: widget values (a job's parameters, or the ones a restarted
        kernel lost), applied before anything runs."""
        path = resolve_in(self.ws.root, rel)
        with self._lock:
            if self.notebook is not None and self.notebook.path == path:
                if preset:
                    self.widgets.preset(preset)
                return self.view()
            if source is not None:
                self._adopt(marimo_io.parse(source, path), preset)
            elif path.is_file():
                self._adopt(marimo_io.read(path), preset)
            else:
                raise FileNotFoundError(f"notebook {rel!r} does not exist")
        return self.view()

    def _adopt(self, nb: Notebook, preset: dict[str, Any] | None = None) -> None:
        self.notebook, self.values, self.states = nb, {}, {}
        self.widgets.reset({n: v for n, v in (preset or {}).items() if isinstance(n, str)})

    def rename(self, rel: str) -> dict[str, Any]:
        """The open notebook moved (the Studio moved its file): same cells,
        values and outputs under the new path."""
        path = resolve_in(self.ws.root, rel)
        with self._lock:
            self._require().path = path
        return self.view()

    def create(self, rel: str, persist: bool = True) -> dict[str, Any]:
        """A new notebook, open; its file is written only when ``persist``."""
        path = resolve_in(self.ws.root, rel)
        if path.suffix != ".py":
            raise ValueError("notebooks are .py files")
        if persist and path.exists():
            raise FileExistsError(f"{rel!r} already exists")
        nb = marimo_io.new_notebook(path)
        if persist:
            marimo_io.write(nb)
        with self._lock:
            self._adopt(nb)
            return {**self.view(), "source": marimo_io.serialize(nb)}

    def _sync(self, cells: list[dict[str, Any]] | None) -> Notebook:
        """Adopt the client's cells (order, code, kinds); forget removed ones."""
        nb = self._require()
        if cells is None:
            return nb
        nb.cells = [Cell.from_view(v) for v in cells]
        alive = {c.id for c in nb.cells}
        for cid in list(self.states):
            if cid not in alive:
                self.states.pop(cid)
                self.values.pop(cid, None)
        for cid in [c for c in self.widgets.cell_ids() if c not in alive]:
            self.widgets.forget_cell(cid)
        return nb

    def save(self, cells: list[dict[str, Any]] | None, persist: bool = True) -> dict[str, Any]:
        """Adopt the cells; return the notebook's source (and write it when ``persist``)."""
        with self._lock:
            nb = self._sync(cells)
            source = marimo_io.serialize(nb)
            if persist:
                marimo_io.write(nb)
        return {"path": nb.path.relative_to(self.ws.root).as_posix(), "source": source}

    def clear(self, rel: str, cells: list[str] | None) -> dict[str, Any]:
        """Outputs of ``cells`` (every cell when None) go back to idle, so a
        reload does not bring them back. Values stay. Queued and running cells
        keep their state: their output is still coming. Nothing is cleared
        unless ``rel`` is the open notebook."""
        path = resolve_in(self.ws.root, rel)
        with self._lock:
            if self.notebook is None or self.notebook.path != path:
                return {"cleared": 0}
            cleared = 0
            for cid in list(self.states) if cells is None else cells:
                s = self.states.get(cid)
                if s is None or s.status in ("queued", "running"):
                    continue
                s.status, s.output, s.streams, s.elapsed_ms, s.frames, s.queries = "idle", None, [], None, [], []
                cleared += 1
        return {"cleared": cleared}

    # -- execution -----------------------------------------------------------
    def _needs_run(self, cell: Cell) -> bool:
        s = self.states.get(cell.id)
        return s is None or s.status != "done" or s.code_run != cell.code

    def _has_value(self, cid: str) -> bool:
        s = self.states.get(cid)
        return s is not None and s.status == "done"

    def _lacks(self, graph: DependencyGraph, cid: str, readers: set[str]) -> bool:
        """Whether a name ``readers`` take from ``cid`` is missing from its value (it was edited to define it since it ran)."""
        have = self.values.get(cid, {})
        return any(src == cid and n not in have for r in readers for n, src in graph.deps[r].sources.items())

    def _plan(self, graph: DependencyGraph, nb: Notebook, targets: list[str], autorun: bool = True) -> list[str]:
        seeds = set(targets)
        # the setup cell comes before any cell: it runs when it never did or was edited
        seeds |= {c for c in graph.setup if self._needs_run(nb.cell(c))} if seeds else set()
        for t in targets:
            if autorun:
                seeds |= {a for a in graph.ancestors(t) if self._needs_run(nb.cell(a))}
            else:
                # inputs with a value are read as they are (even if edited since), unless it lacks a name they read
                up = graph.ancestors(t)
                seeds |= {a for a in up if not self._has_value(a) or self._lacks(graph, a, up | {t})}
        plan = set(seeds)
        if autorun:
            for s in seeds:
                plan |= graph.descendants(s)
        ordered = graph.topological(plan)
        ordered = [c for c in ordered if c in graph.setup] + [c for c in ordered if c not in graph.setup]
        # cells inside a dependency cycle are reported as errors, not skipped
        return ordered + [c for c in graph.order if c in plan and c not in ordered]

    def _emit_widgets(self, emit: Emit) -> None:
        """Tell the client when the widgets (their definitions or values) changed since last told."""
        changes = self.widgets.take_changes()
        if changes is not None:
            emit("widgets.changed", changes)

    def _emit_state(self, emit: Emit, cell: Cell) -> None:
        emit("cell.state", {"cell_id": cell.id, **self.states[cell.id].view(cell.code)})

    def _finish(self, cell: Cell, outcome: Outcome, defs: tuple[str, ...]) -> None:
        s = self.states[cell.id]
        s.status, s.output, s.elapsed_ms, s.code_run = outcome.status, outcome.output, outcome.elapsed_ms, cell.code
        s.frames, s.queries = outcome.frames, outcome.queries
        if outcome.status == "done":
            self.values[cell.id] = dict(outcome.defs)
            s.defs = defs

    @staticmethod
    def _blocked(reason: str) -> Outcome:
        return Outcome("error", {"type": "error", "ename": "Blocked", "evalue": reason, "traceback": ""})

    def run(self, cells: list[dict[str, Any]] | None, targets: list[str] | None, emit: Emit, autorun: bool = False, stop_on_error: bool = True) -> dict[str, Any]:
        """Run ``targets`` (every cell when None: all of them run); ``autorun``:
        the cells that read their values run too, instead of turning stale.
        ``stop_on_error``: the run ends at the first cell that fails, and the
        cells after it do not run, as in a notebook (otherwise the cells that
        read from a failed cell are blocked and the rest still run). A single
        target always goes on: a failure elsewhere must not keep it from running."""
        stop_on_error = stop_on_error and (targets is None or len(targets) != 1)
        with self._lock:
            nb = self._sync(cells)
            self._emit_widgets(emit)
            # a snapshot: saves arriving during the run may replace nb.cells
            snapshot = {c.id: c for c in nb.cells}
            graph = DependencyGraph(nb.cells)
            order = self._plan(graph, nb, targets if targets is not None else graph.order, autorun or targets is None)
            for cid in order:
                st = self.states.setdefault(cid, CellState())
                st.prev_status, st.status, st.streams = st.status, "queued", []
                self._emit_state(emit, snapshot[cid])
        source = nb.path.relative_to(self.ws.root).as_posix()
        failed: set[str] = set()
        ran: list[str] = []
        for i, cid in enumerate(order):
            cell = snapshot[cid]
            deps = graph.deps[cid]
            defs = tuple(sorted(graph.analyses[cid].defs))
            with self._lock:
                self.values.pop(cid, None)
                self.states[cid].defs = ()
            if cid in graph.errors:
                outcome = self._blocked(graph.errors[cid])
            elif deps.parents & graph.setup & failed:
                outcome = self._blocked("the setup cell failed")
            elif deps.parents & failed:
                outcome = self._blocked("an upstream cell failed")
            else:
                with self._lock:
                    inputs = {r: self.values[src][r] for r, src in deps.sources.items() if r in self.values.get(src, {})}
                    self.states[cid].status = "running"
                    self._emit_state(emit, cell)
                with self.widgets.cell(cid):
                    outcome = self.runner.run(cell, deps, graph.analyses[cid].defs, inputs, self._stream_into(emit, cid), source)
                ran.append(cid)
            with self._lock:
                self._finish(cell, outcome, defs)
                self._emit_state(emit, cell)
                self._emit_widgets(emit)
            if outcome.status != "done":
                failed.add(cid)
            if outcome.status == "cancelled" or (outcome.status == "error" and stop_on_error):
                self._unqueue([snapshot[c] for c in order[i + 1 :]], emit)
                self._mark_stale(graph, snapshot, ran, emit)
                return {"ran": ran, "interrupted": outcome.status == "cancelled"}
        self._mark_stale(graph, snapshot, ran, emit)
        return {"ran": ran, "interrupted": False}

    def _mark_stale(self, graph: DependencyGraph, cells: dict[str, Cell], ran: list[str], emit: Emit) -> None:
        """The cells that read from cells that ran, and did not run themselves, are stale."""
        done = set(ran)
        with self._lock:
            for cid in done:
                self.states[cid].inputs_changed = False
            for cid in sorted({d for c in done for d in graph.descendants(c)} - done, key=graph.order.index):
                s = self.states.setdefault(cid, CellState())
                if s.status in ("done", "error") and not s.inputs_changed:
                    s.inputs_changed = True
                    self._emit_state(emit, cells[cid])

    def set_widget(self, name: str, value: Any, cells: list[dict[str, Any]] | None, emit: Emit) -> dict[str, Any]:
        """A widget got a new value (coerced to its type): the cells that read
        it run, then their descendants, as when a cell is run."""
        with self._lock:
            nb = self._sync(cells)
            self.widgets.set(name, value)
            targets = DependencyGraph(nb.cells).widget_readers(name)
            self._emit_widgets(emit)
        if not targets:
            return {"ran": [], "interrupted": False}
        # a widget is for exploring: what depends on it runs, past a failure too
        return self.run(None, targets, emit, autorun=True, stop_on_error=False)

    def _unqueue(self, rest: list[Cell], emit: Emit) -> None:
        with self._lock:
            for cell in rest:
                st = self.states[cell.id]
                st.status = st.prev_status
                self._emit_state(emit, cell)

    def _stream_into(self, emit: Emit, cid: str) -> Emit:
        """Forward events, also keeping stream text in the cell state."""

        def forward(event: str, data: dict[str, Any]) -> None:
            if event == "cell.stream":
                with self._lock:
                    streams = self.states[cid].streams
                    if streams and streams[-1]["stream"] == data["stream"]:
                        streams[-1]["text"] += data["text"]
                    else:
                        streams.append({"stream": data["stream"], "text": data["text"]})
            emit(event, data)

        return forward

    def namespace(self, cell_id: str | None = None) -> dict[str, Any]:
        """A snapshot of the values cells defined: as the notebook ends (a
        redefined name has its last value), or as ``cell_id`` sees them (the
        nearest definition above it)."""
        with self._lock:
            order = [c.id for c in self.notebook.cells] if self.notebook else list(self.values)
            if cell_id in order:
                order = order[: order.index(cell_id)]
            out: dict[str, Any] = {}
            for cid in order:
                out.update(self.values.get(cid, {}))
            return out

    def cells(self) -> list[Cell] | None:
        """The cells as of the last save (``None``: no notebook is open)."""
        with self._lock:
            return None if self.notebook is None else list(self.notebook.cells)

    def variables(self) -> list[dict[str, Any]]:
        with self._lock:
            order = [c.id for c in self.notebook.cells] if self.notebook else list(self.values)
            # the last definition of each name, in notebook order
            last: dict[str, tuple[str, Any]] = {}
            for cid in order:
                for n, v in self.values.get(cid, {}).items():
                    last[n] = (cid, v)
            return [
                {"name": n, "type": type(v).__name__, "summary": summarize(v), "cell_id": cid}
                for n, (cid, v) in sorted(last.items())
                if not n.startswith("_") and type(v).__name__ != "module"
            ]
