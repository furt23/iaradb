"""Static analysis of cells: which names a cell defines and which it reads.

Python cells are analysed with the scope visitor of
:mod:`workhouse.kernel.notebook.scopes` (comprehension variables, nested
functions, walrus targets, ...). SQL cells define their output name and read
the identifiers of their query (matched against the names other cells define).
"""

from __future__ import annotations

import ast
import builtins
import re
from dataclasses import dataclass, field

from workhouse.kernel.notebook.model import Cell
from workhouse.kernel.notebook.scopes import module_scope

_BUILTINS = frozenset(dir(builtins))
_SQL_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
#: name of the workspace session that SQL cells run against
WORKSPACE_VAR = "ws"


@dataclass(frozen=True)
class Analysis:
    #: public names bound at the cell's top level
    defs: frozenset[str] = frozenset()
    #: free names the cell reads (candidates for references to other cells)
    refs: frozenset[str] = frozenset()
    #: identifiers that may name tables (SQL cells; matched case-insensitively)
    sql_idents: frozenset[str] = frozenset()
    error: str | None = None
    #: names private to the cell (``_x``), never shared
    private: frozenset[str] = field(default=frozenset())


def is_private(name: str) -> bool:
    return name.startswith("_")


def analyze_python(code: str) -> Analysis:
    try:
        tree = ast.parse(code, "<cell>")
    except SyntaxError as e:
        return Analysis(error=f"SyntaxError: {e.msg} (line {e.lineno})")
    scope = module_scope(tree)
    refs = {n for n in scope.free() - scope.bound if n not in _BUILTINS and not is_private(n)}
    defs = {n for n in scope.bound if not is_private(n)}
    private = {n for n in scope.bound if is_private(n)}
    return Analysis(frozenset(defs), frozenset(refs), error=None, private=frozenset(private))


def sql_identifiers(query: str) -> set[str]:
    """Identifier-like tokens of a query, outside string literals and comments."""
    text = re.sub(r"'(?:[^']|'')*'", " ", query)
    text = re.sub(r"--[^\n]*", " ", text)
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    return {m.group(0) for m in _SQL_IDENT.finditer(text)}


def analyze(cell: Cell) -> Analysis:
    if cell.kind == "markdown":
        return Analysis()
    if cell.kind == "sql":
        output = cell.output or ""
        if output and (not output.isidentifier() or is_private(output)):
            return Analysis(error=f"invalid result name {output!r}")
        defs = frozenset({output} if output else ())
        return Analysis(defs=defs, refs=frozenset({WORKSPACE_VAR}), sql_idents=frozenset(sql_identifiers(cell.code)))
    return analyze_python(cell.code)
