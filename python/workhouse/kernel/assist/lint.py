"""Diagnostics for cells.

Python: syntax errors (with Python's own messages) and names that no cell
defines. A cell may redefine another cell's names: the cells below it read
its value. SQL: parse and planning errors, located in the query when the
message says where.
"""

from __future__ import annotations

import ast
import builtins
import re
from collections.abc import Callable, Iterable, Iterator
from typing import Any

from workhouse.kernel.assist.text import Positions
from workhouse.kernel.notebook.scopes import module_scope

_BUILTINS = frozenset(dir(builtins)) | {"__file__", "__name__", "__doc__", "__builtins__", "__spec__", "__loader__"}
_NESTED = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
_SQL_LOCATION = re.compile(r"Line: (\d+), Column: (\d+)")
_QUOTED = re.compile(r"'([^']+)'")


def diagnostic(start: int, end: int, message: str, severity: str = "error") -> dict[str, Any]:
    return {"from": start, "to": max(start, end), "severity": severity, "message": message}


# ---------------------------------------------------------------------------
# Python
# ---------------------------------------------------------------------------


def _syntax_error(pos: Positions, e: SyntaxError) -> dict[str, Any]:
    line, col = e.lineno or 1, (e.offset or 1) - 1
    start = pos.offset(line, col)
    end = start
    if e.end_lineno and e.end_offset and (e.end_lineno, e.end_offset - 1) > (line, col):
        end = pos.offset(e.end_lineno, e.end_offset - 1)
    if end == start and start < pos.line_end(line):
        end = start + 1
    return diagnostic(start, end, f"{type(e).__name__}: {e.msg}")


def _span(pos: Positions, node: ast.AST) -> tuple[int, int]:
    start = pos.offset_bytes(node.lineno, node.col_offset)  # type: ignore[attr-defined]
    end = pos.offset_bytes(node.end_lineno or node.lineno, node.end_col_offset or node.col_offset)  # type: ignore[attr-defined]
    return start, end


def _module_level(node: ast.AST) -> Iterator[ast.AST]:
    """Nodes of the module's own scope (not inside functions, classes, ...)."""
    for child in ast.iter_child_nodes(node):
        yield child
        if not isinstance(child, _NESTED):
            yield from _module_level(child)


def has_star_import(tree: ast.AST) -> bool:
    return any(isinstance(n, ast.ImportFrom) and any(a.name == "*" for a in n.names) for n in ast.walk(tree))


def lint_python(code: str, others: Iterable[str] | None, available: Iterable[str] = ()) -> list[dict[str, Any]]:
    """Diagnostics for a Python cell.

    ``others``: names the notebook's other cells define (``None`` when they
    are unknown: undefined names are then not reported);
    ``available``: further names a cell can read (values in the kernel).
    """
    pos = Positions(code)
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [_syntax_error(pos, e)]
    if others is None or has_star_import(tree):
        return []
    others = set(others)
    scope = module_scope(tree)
    known = others | set(available) | _BUILTINS
    undefined = {n for n in scope.free() - scope.bound if n not in known}
    out = [
        diagnostic(*_span(pos, node), f"'{node.id}' is not defined", "warning")
        for node in ast.walk(tree)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in undefined
    ]
    # `df = df.filter(...)` with no other cell defining df: its first read fails
    for name in sorted((scope.early & scope.bound) - known):
        first = next(
            (n for n in _module_level(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id == name),
            None,
        )
        if first is not None:
            out.append(diagnostic(*_span(pos, first), f"'{name}' is read before it is defined", "warning"))
    return out


# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------


def _word_end(code: str, start: int) -> int:
    m = re.compile(r"\w+|\S").match(code, start)
    return m.end() if m else start


def _occurrences(code: str, name: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in re.finditer(rf"(?<![\w.]){re.escape(name)}\b", code, re.IGNORECASE)]


def lint_sql(code: str, plan: Callable[[str], object], pending: Iterable[str] = ()) -> list[dict[str, Any]]:
    """Plan the query (without running it) and locate its error, if any.

    ``pending``: names of values other cells define but have not computed
    yet; errors mentioning them are not reported.
    """
    if not code.strip():
        return []
    try:
        plan(code)
        return []
    except Exception as e:  # noqa: BLE001 - any planning error is a diagnostic
        message = str(e).removeprefix("SQL error: ")
    lowered = message.lower()
    if any(re.search(rf"\b{re.escape(n.lower())}\b", lowered) for n in pending):
        return []
    pos = Positions(code)
    m = _SQL_LOCATION.search(message)
    if m:
        start = pos.offset(int(m.group(1)), int(m.group(2)) - 1)
        return [diagnostic(start, _word_end(code, start), message)]
    if "found: EOF" in message:
        end = len(code.rstrip())
        return [diagnostic(max(0, end - 1), end, message)]
    for quoted in _QUOTED.findall(message):
        spans = _occurrences(code, quoted.split(".")[-1])
        if spans:
            return [diagnostic(a, b, message) for a, b in spans]
    first = next((i for i, line in enumerate(pos.lines, 1) if line.strip()), 1)
    return [diagnostic(pos.offset(first, 0), pos.line_end(first), message)]
