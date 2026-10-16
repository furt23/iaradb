"""Static analysis of cells: which names a cell defines and which it reads.

Python cells are analysed with the scope visitor of
:mod:`iara.kernel.notebook.scopes` (comprehension variables, nested
functions, walrus targets, ...). SQL cells define their output name and read
the identifiers of their query (matched against the names other cells define).
"""

from __future__ import annotations

import ast
import builtins
import re
from dataclasses import dataclass, field

from iara.kernel.notebook.model import Cell
from iara.kernel.notebook.scopes import module_scope

_BUILTINS = frozenset(dir(builtins))
#: a name as SQL writes it: ``t``, ``s.t`` or ``"s"."t"`` (dotted parts make one name)
_SQL_NAME = re.compile(r'(?:[A-Za-z_][A-Za-z0-9_]*|"[^"]*")(?:\s*\.\s*(?:[A-Za-z_][A-Za-z0-9_]*|"[^"]*"))*')
#: name of the workspace session that SQL cells run against
WORKSPACE_VAR = "ws"


@dataclass(frozen=True)
class Analysis:
    #: public names bound at the cell's top level
    defs: frozenset[str] = frozenset()
    #: names the cell reads from outside: free names, and names it reads
    #: before binding them itself (candidates for references to other cells)
    refs: frozenset[str] = frozenset()
    #: identifiers that may name tables (SQL cells; matched case-insensitively)
    sql_idents: frozenset[str] = frozenset()
    error: str | None = None
    #: names private to the cell (``_x``), never shared
    private: frozenset[str] = field(default=frozenset())
    #: widgets the cell reads or defines (``"*"``: any, when a name is not literal); it re-runs when one changes
    widgets: frozenset[str] = frozenset()
    #: widgets the cell defines
    widget_defs: frozenset[str] = frozenset()


#: ``ia.widgets.<kind>(...)`` calls that define a widget
WIDGET_KINDS = frozenset({"text", "number", "dropdown", "multiselect", "checkbox", "date"})
#: widgets are tracked as dependencies on this synthetic name (``__widget_<name>``)
WIDGET_PREFIX = "__widget_"
ANY_WIDGET = "*"
#: a ``:name`` placeholder in SQL (not a ``::`` cast)
_PLACEHOLDER = re.compile(r"(?<![:\w]):([A-Za-z_][A-Za-z0-9_]*)")


def is_private(name: str) -> bool:
    return name.startswith("_")


def widget_dependency(name: str) -> str:
    return WIDGET_PREFIX + name


def _is_widgets(node: ast.expr) -> bool:
    """``widgets`` or ``<anything>.widgets`` (``ia.widgets``)."""
    return (isinstance(node, ast.Name) and node.id == "widgets") or (isinstance(node, ast.Attribute) and node.attr == "widgets")


def widget_calls(tree: ast.AST) -> tuple[set[str], set[str]]:
    """``(defined, read)`` widget names of ``ia.widgets.<kind>("x", ...)`` and
    ``ia.widgets.get("x")`` calls; a name that is not a literal (and
    ``params()``) stands for any widget (``"*"``)."""
    defined: set[str] = set()
    read: set[str] = set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and _is_widgets(node.func.value)):
            continue
        attr = node.func.attr
        if attr == "params":
            read.add(ANY_WIDGET)
        elif attr == "get" or attr in WIDGET_KINDS:
            arg = node.args[0] if node.args else next((k.value for k in node.keywords if k.arg == "name"), None)
            name = arg.value if isinstance(arg, ast.Constant) and isinstance(arg.value, str) else ANY_WIDGET
            (read if attr == "get" else defined).add(name)
    return defined, read


def sql_placeholders(query: str) -> list[str]:
    """The ``:name`` placeholders of a query (outside literals and comments), in order of appearance, once each."""
    text = re.sub(r"'(?:[^']|'')*'", " ", query)
    text = re.sub(r'"[^"]*"', " ", text)
    text = re.sub(r"--[^\n]*", " ", text)
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    return list(dict.fromkeys(_PLACEHOLDER.findall(text)))


def analyze_python(code: str) -> Analysis:
    try:
        tree = ast.parse(code, "<cell>")
    except SyntaxError as e:
        return Analysis(error=f"SyntaxError: {e.msg} (line {e.lineno})")
    scope = module_scope(tree)
    # free names, and names read before the cell rebinds them (`df = df.filter(...)`)
    read = (scope.free() - scope.bound) | (scope.early & scope.bound)
    refs = {n for n in read if n not in _BUILTINS and not is_private(n)}
    defs = {n for n in scope.bound if not is_private(n)}
    private = {n for n in scope.bound if is_private(n)}
    wdefs, wreads = widget_calls(tree)
    return Analysis(
        frozenset(defs), frozenset(refs), error=None, private=frozenset(private), widgets=frozenset(wdefs | wreads), widget_defs=frozenset(wdefs)
    )


def sql_identifiers(query: str) -> set[str]:
    """Names a query mentions, outside string literals and comments. A dotted
    name (``schema.table``) is one name: a qualified table, not a variable
    called ``table``."""
    text = re.sub(r"'(?:[^']|'')*'", " ", query)
    text = re.sub(r"--[^\n]*", " ", text)
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    return {_plain(m.group(0)) for m in _SQL_NAME.finditer(text)}


def _plain(name: str) -> str:
    """``"tpch" . "lineitem"`` as ``tpch.lineitem``."""
    return re.sub(r"\s*\.\s*", ".", name).replace('"', "")


def analyze(cell: Cell) -> Analysis:
    if cell.kind == "markdown":
        return Analysis()
    if cell.kind == "sql":
        output = cell.output or ""
        if output and (not output.isidentifier() or is_private(output)):
            return Analysis(error=f"invalid result name {output!r}")
        defs = frozenset({output} if output else ())
        return Analysis(
            defs=defs,
            refs=frozenset({WORKSPACE_VAR}),
            sql_idents=frozenset(sql_identifiers(cell.code)),
            widgets=frozenset(sql_placeholders(cell.code)),
        )
    return analyze_python(cell.code)
