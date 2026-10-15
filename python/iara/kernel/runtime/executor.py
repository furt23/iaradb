"""Execute Python cell code in an isolated namespace.

Each run starts from a fresh namespace holding only the values the cell
references, so results never depend on stale state; afterwards the names the
cell defines are read back out. A trailing expression is the cell's value.
Top-level ``await`` is supported.
"""

from __future__ import annotations

import ast
import asyncio
import builtins
import inspect
import linecache
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ExecResult:
    value: Any = None
    defs: dict[str, Any] = field(default_factory=dict)
    error: BaseException | None = None


def _register_source(filename: str, code: str) -> None:
    """Make tracebacks show the cell's source lines."""
    linecache.cache[filename] = (len(code), None, code.splitlines(keepends=True), filename)


def _evaluate(code: Any, ns: dict[str, Any]) -> Any:
    result = eval(code, ns)
    if code.co_flags & inspect.CO_COROUTINE:
        result = asyncio.run(result)
    return result


def run_python(code: str, inputs: dict[str, Any], defs: Iterable[str], filename: str) -> ExecResult:
    _register_source(filename, code)
    ns: dict[str, Any] = {"__builtins__": builtins, "__name__": "__main__", **inputs}
    try:
        tree = ast.parse(code, filename)
        last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
        _evaluate(compile(tree, filename, "exec", flags=flags), ns)
        value = None
        if last is not None:
            expr = ast.Expression(last.value)
            ast.copy_location(expr, last)
            value = _evaluate(compile(expr, filename, "eval", flags=flags), ns)
    except BaseException as e:  # noqa: BLE001 - user code may raise anything
        return ExecResult(error=e)
    return ExecResult(value, {d: ns[d] for d in defs if d in ns})
