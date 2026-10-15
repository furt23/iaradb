"""Completions and call signatures from jedi, over a cell's code and the
values the notebook's cells defined (so ``df.`` completes the columns'
DataFrame methods, ``wh.`` the module's functions, with their docs)."""

from __future__ import annotations

import re
import threading
from types import ModuleType
from typing import Any

from workhouse.kernel.assist.text import Positions

#: jedi is not thread-safe: completions, signatures and the warm-up take turns
_JEDI = threading.Lock()

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


# `F.col("a").str.` -> "F.col("a").str": the expression before the dot being completed
_OWNER = re.compile(r"([A-Za-z_][\w.]*)\.\w*$")


def _public(code: str, cursor: int, namespace: dict[str, Any]) -> set[str] | None:
    """The public names of the module being completed (``wh.``): its ``__all__``.

    Without it a module lists everything it imported (``Any``, ``annotations``,
    its submodules); ``None`` when the completion is not on such a module."""
    m = _OWNER.search(code[:cursor].splitlines()[-1] if code[:cursor] else "")
    if not m:
        return None
    obj: Any = namespace
    for i, part in enumerate(m.group(1).split(".")):
        obj = obj.get(part) if i == 0 else getattr(obj, part, None)
        if obj is None:
            return None
    names = getattr(obj, "__all__", None) if isinstance(obj, ModuleType) else None
    return set(names) if names else None


def warm_up() -> None:
    """jedi's first completion loads its caches (about a second): do it now,
    in the background, so the first one typed in a notebook is quick."""

    def run() -> None:
        try:
            from workhouse import functions as F

            complete('F.col("a").str.', 15, {"F": F})
        except Exception:  # noqa: BLE001 - only a warm-up
            pass

    threading.Thread(target=run, name="assist-warm-up", daemon=True).start()


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
    with _JEDI:
        return _complete(code, cursor, namespace)


def _complete(code: str, cursor: int, namespace: dict[str, Any]) -> dict[str, Any]:
    line, col = Positions(code).line_col(cursor)
    try:
        found = _script(code, namespace).complete(line, col)
    except Exception:  # noqa: BLE001 - jedi fails on some broken code
        return {"from": cursor, "items": []}
    if not found:
        return {"from": cursor, "items": []}
    typed = len(found[0].name) - len(found[0].complete)
    public = _public(code, cursor, namespace)
    if public is not None:
        found = [c for c in found if c.name in public]
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
    with _JEDI:
        return _signature(code, cursor, namespace)


def _signature(code: str, cursor: int, namespace: dict[str, Any]) -> dict[str, Any] | None:
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
