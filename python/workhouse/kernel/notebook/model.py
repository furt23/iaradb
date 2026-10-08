"""In-memory notebook model.

A cell is one of three kinds:

- ``python``: arbitrary code; top-level names it binds are visible to other
  cells (names starting with ``_`` stay private to the cell, as in marimo);
- ``sql``: a query whose result is bound to the cell's ``output`` name; it can
  read catalog tables and table-like values defined by other cells;
- ``markdown``: text rendered by the client.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

CellKind = Literal["python", "sql", "markdown"]
CELL_KINDS: tuple[str, ...] = ("python", "sql", "markdown")


def new_cell_id() -> str:
    return uuid.uuid4().hex[:10]


@dataclass
class Cell:
    id: str
    kind: CellKind
    code: str
    #: marimo function name (``_`` for anonymous cells)
    name: str = "_"
    #: SQL cells: the variable the result is bound to
    output: str | None = None
    #: marimo decorator options, e.g. ``{"hide_code": True}``
    config: dict[str, Any] = field(default_factory=dict)
    #: marimo ``with app.setup:`` block: its names are global to every cell
    setup: bool = False

    def to_view(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "code": self.code,
            "name": self.name,
            "output": self.output,
            "config": self.config,
            "setup": self.setup,
        }

    @staticmethod
    def from_view(v: dict[str, Any]) -> Cell:
        kind = v.get("kind", "python")
        if kind not in CELL_KINDS:
            raise ValueError(f"unknown cell kind {kind!r}")
        return Cell(
            id=str(v.get("id") or new_cell_id()),
            kind=kind,
            code=str(v.get("code", "")),
            name=str(v.get("name") or "_"),
            output=v.get("output") or None,
            config=dict(v.get("config") or {}),
            setup=bool(v.get("setup", False)),
        )


@dataclass
class Notebook:
    path: Path
    cells: list[Cell] = field(default_factory=list)
    #: source of the ``marimo.App(...)`` arguments, kept verbatim
    app_args: str = ""
    generated_with: str = "workhouse"
    #: top-level blocks we do not model (``@app.function``, ...), kept verbatim
    extra: list[str] = field(default_factory=list)

    def cell(self, cell_id: str) -> Cell:
        for c in self.cells:
            if c.id == cell_id:
                return c
        raise KeyError(f"no cell {cell_id!r}")

    def index(self, cell_id: str) -> int:
        return next(i for i, c in enumerate(self.cells) if c.id == cell_id)
