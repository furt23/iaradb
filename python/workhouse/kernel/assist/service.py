"""Code assistance for the open notebook: what the assist methods of the
kernel protocol answer."""

from __future__ import annotations

from typing import Any

from workhouse.kernel.assist.completion import complete, signature
from workhouse.kernel.assist.lint import lint_python, lint_sql
from workhouse.kernel.notebook.analysis import WORKSPACE_VAR, analyze, sql_identifiers
from workhouse.kernel.notebook_service import NotebookService
from workhouse.workspaces import Workspace


class AssistService:
    def __init__(self, ws: Workspace, notebook: NotebookService) -> None:
        self.ws = ws
        self.notebook = notebook

    def _namespace(self) -> dict[str, Any]:
        return self.notebook.namespace()

    def _other_defs(self, cell_id: str | None) -> set[str] | None:
        """Names the notebook's other cells define (as of the last save)."""
        cells = self.notebook.cells()
        if cells is None:
            return None
        names: set[str] = set()
        for c in cells:
            if c.id != cell_id:
                names |= analyze(c).defs
        return names

    def complete(self, p: dict[str, Any]) -> dict[str, Any]:
        return complete(p["code"], int(p["cursor"]), self._namespace())

    def signature(self, p: dict[str, Any]) -> dict[str, Any] | None:
        return signature(p["code"], int(p["cursor"]), self._namespace())

    def lint(self, p: dict[str, Any]) -> list[dict[str, Any]]:
        kind, code, cell_id = p.get("kind", "python"), p["code"], p.get("cell_id")
        if kind == "python":
            return lint_python(code, self._other_defs(cell_id), self._namespace())
        if kind == "sql":
            return self._lint_sql(code, cell_id)
        return []

    def _lint_sql(self, code: str, cell_id: str | None) -> list[dict[str, Any]]:
        values = self._namespace()
        idents = {i.lower() for i in sql_identifiers(code)}
        tables = {n: v for n, v in values.items() if n.lower() in idents}
        ws = values.get(WORKSPACE_VAR)
        ws = ws if isinstance(ws, Workspace) else self.ws
        pending = (self._other_defs(cell_id) or set()) - values.keys()
        return lint_sql(code, lambda q: ws.sql(q, **tables), pending)
