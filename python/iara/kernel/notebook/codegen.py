"""Source code of SQL and markdown cells inside marimo cell functions.

SQL cells are stored as plain Python that also runs without Iara
Studio (``python notebook.py`` / ``marimo run``)::

    top = ws.sql(
        \"\"\"
        select o_custkey, sum(o_totalprice) from orders group by 1
        \"\"\",
        recent=recent,
    ).collect()

Markdown cells use marimo's own form, ``mo.md(r\"\"\"...\"\"\")``.
"""

from __future__ import annotations

import ast
import textwrap

from iara.kernel.notebook.analysis import WORKSPACE_VAR, sql_placeholders

INDENT = "    "
#: keyword of a SQL cell's call that binds ``:name`` placeholders to the notebook's widgets
PARAMS_KEYWORD = "params"
PARAMS_VALUE = "iara.widgets.params()"


def _triple_quoted(text: str) -> str:
    """A raw triple-quoted literal whose lines align with its opening quotes
    once the caller indents it (the content is dedented when read back)."""
    body = "\n" + text.strip("\n") + "\n"
    if '"""' not in body and not body.rstrip().endswith("\\"):
        return 'r"""' + body + '"""'
    return repr(text)


def sql_source(output: str | None, query: str, tables: list[str]) -> str:
    target = output or "_df"
    lines = [f"{target} = {WORKSPACE_VAR}.sql(", textwrap.indent(_triple_quoted(query), INDENT) + ","]
    if sql_placeholders(query):
        lines.append(f"{INDENT}{PARAMS_KEYWORD}={PARAMS_VALUE},")
    lines += [f"{INDENT}{t}={t}," for t in tables]
    lines.append(").collect()")
    return "\n".join(lines)


def markdown_source(text: str) -> str:
    return "mo.md(\n" + textwrap.indent(_triple_quoted(text), INDENT) + "\n)"


def _is_widget_params(node: ast.AST) -> bool:
    return isinstance(node, ast.Call) and not node.args and not node.keywords and ast.unparse(node) == PARAMS_VALUE


def _string_constant(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return textwrap.dedent(node.value).strip("\n")
    return None


def _is_attr_call(node: ast.AST, obj: str, attr: str) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == attr
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == obj
    )


def detect_sql(code: str) -> tuple[str, str | None] | None:
    """``(query, output)`` when ``code`` is a generated SQL cell."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return None
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.Assign):
        return None
    stmt = tree.body[0]
    if len(stmt.targets) != 1 or not isinstance(stmt.targets[0], ast.Name):
        return None
    call = stmt.value
    if not (isinstance(call, ast.Call) and not call.args and isinstance(call.func, ast.Attribute) and call.func.attr == "collect"):
        return None
    inner = call.func.value
    if not _is_attr_call(inner, WORKSPACE_VAR, "sql") or len(inner.args) != 1:
        return None
    if not all((isinstance(k.value, ast.Name) and k.arg == k.value.id) or (k.arg == PARAMS_KEYWORD and _is_widget_params(k.value)) for k in inner.keywords):
        return None
    query = _string_constant(inner.args[0])
    if query is None:
        return None
    output = stmt.targets[0].id
    return query, (None if output == "_df" else output)


def detect_markdown(code: str) -> str | None:
    """The text when ``code`` is a plain ``mo.md("...")`` cell."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return None
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.Expr):
        return None
    call = tree.body[0].value
    if not _is_attr_call(call, "mo", "md") or len(call.args) != 1 or call.keywords:
        return None
    return _string_constant(call.args[0])
