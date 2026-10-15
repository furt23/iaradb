"""Code assistance for the open notebook: what the assist methods of the
kernel protocol answer."""

from __future__ import annotations

from typing import Any

from iara.kernel.assist.completion import complete, signature, warm_up
from iara.kernel.assist.lint import lint_python, lint_sql
from iara.kernel.notebook.analysis import WORKSPACE_VAR, analyze, sql_identifiers
from iara.kernel.notebook_service import NotebookService
from iara.workspaces import Workspace


class AssistService:
    def __init__(self, ws: Workspace, notebook: NotebookService) -> None:
        self.ws = ws
        self.notebook = notebook
        warm_up()

    def _namespace(self, cell_id: str | None = None) -> dict[str, Any]:
        """The values as the cell ``cell_id`` sees them (a redefined name: its
        nearest definition above the cell)."""
        return self.notebook.namespace(cell_id)

    def _completion_namespace(self, cell_id: str | None) -> dict[str, Any]:
        """The notebook's values over what its setup cell defines (``iara``,
        ``ws``): completions should know them before it runs."""
        return {**self._setup_names(), **self._namespace(cell_id)}

    def _setup_names(self) -> dict[str, Any]:
        import iara

        known = {"iara": iara, WORKSPACE_VAR: self.ws}
        setup = [c for c in self.notebook.cells() or [] if c.setup]
        if not setup:
            return {"iara": iara, WORKSPACE_VAR: self.ws}
        names = {n for c in setup for n in analyze(c).defs}
        return {n: v for n, v in known.items() if n in names}

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
        return complete(p["code"], int(p["cursor"]), self._completion_namespace(p.get("cell_id")))

    def signature(self, p: dict[str, Any]) -> dict[str, Any] | None:
        return signature(p["code"], int(p["cursor"]), self._completion_namespace(p.get("cell_id")))

    def lint(self, p: dict[str, Any]) -> list[dict[str, Any]]:
        kind, code, cell_id = p.get("kind", "python"), p["code"], p.get("cell_id")
        if kind == "python":
            return lint_python(code, self._other_defs(cell_id), self._namespace(cell_id))
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
