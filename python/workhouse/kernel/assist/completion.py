"""Completions and call signatures from jedi, over a cell's code and the
values the notebook's cells defined (so ``df.`` completes the columns'
DataFrame methods, ``wh.`` the module's functions, with their docs)."""

from __future__ import annotations

import re
from typing import Any

from workhouse.kernel.assist.text import Positions

#: completions sent with a signature and docstring (the rest: names only)
DETAILED = 40
MAX_ITEMS = 300
DOC_CHARS = 2000

#: jedi completion types -> editor completion types
_KINDS = {
    "module": "namespace",
    "class": "class",
    "instance": "variable",
    "function": "function",
    "param": "variable",
    "path": "text",
    "keyword": "keyword",
    "property": "property",
    "statement": "variable",
}

# `x: 'str'` (postponed annotations) -> `x: str`
_QUOTED_ANNOTATION = re.compile(r"(:\s*|->\s*|\|\s*|\[)'([^']*)'")


def _clean(signature: str) -> str:
    return _QUOTED_ANNOTATION.sub(r"\1\2", signature)


def _script(code: str, namespace: dict[str, Any]) -> Any:
    import jedi

    return jedi.Interpreter(code, [namespace])


def _details(c: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        sigs = c.get_signatures()
        if sigs:
            text = _clean(sigs[0].to_string())
            out["signature"] = text
            out["detail"] = text[text.find("(") :] if "(" in text else text
        doc = c.docstring(raw=True)
        if doc:
            out["doc"] = doc[:DOC_CHARS]
    except Exception:  # noqa: BLE001 - introspection of arbitrary objects
        pass
    return out


def complete(code: str, cursor: int, namespace: dict[str, Any]) -> dict[str, Any]:
    """``{"from": offset, "items": [...]}``: completions for the word at
    ``cursor``, which replace ``code[from:cursor]``."""
    line, col = Positions(code).line_col(cursor)
    try:
        found = _script(code, namespace).complete(line, col)
    except Exception:  # noqa: BLE001 - jedi fails on some broken code
        return {"from": cursor, "items": []}
    if not found:
        return {"from": cursor, "items": []}
    typed = len(found[0].name) - len(found[0].complete)
    items = []
    for i, c in enumerate(found[:MAX_ITEMS]):
        item: dict[str, Any] = {"label": c.name, "type": _KINDS.get(c.type, "variable")}
        if i < DETAILED:
            item.update(_details(c))
        items.append(item)
    return {"from": cursor - typed, "items": items}


def signature(code: str, cursor: int, namespace: dict[str, Any]) -> dict[str, Any] | None:
    """The call the cursor is in: its signature, parameters and the index of
    the parameter being typed."""
    line, col = Positions(code).line_col(cursor)
    try:
        sigs = _script(code, namespace).get_signatures(line, col)
    except Exception:  # noqa: BLE001
        return None
    if not sigs:
        return None
    s = sigs[0]
    try:
        doc = s.docstring(raw=True) or ""
    except Exception:  # noqa: BLE001
        doc = ""
    text = _clean(s.to_string())
    returns = text[text.rfind(")") + 1 :].strip().removeprefix("->").strip() if ")" in text else ""
    return {
        "name": s.name,
        "params": [_clean(p.to_string()) for p in s.params],
        "active": s.index,
        "returns": returns or None,
        "doc": doc[:DOC_CHARS],
    }
