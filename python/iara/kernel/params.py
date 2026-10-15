"""Query parameters sent by the Studio: values as JSON plus their declared types.

A request carries ``params`` (``name -> JSON value``) and, optionally,
``param_types`` (``name -> "text" | "number" | "boolean" | "date" | "select"``).
JSON has no date, so a ``date`` parameter arrives as an ISO ``YYYY-MM-DD``
string and is converted to a ``datetime.date`` here.
"""

from __future__ import annotations

import datetime as dt
from typing import Any


def bind_params(p: dict[str, Any]) -> dict[str, Any] | None:
    """The named values of a ``sql.*`` request, ready for ``Workspace.sql(params=...)``."""
    raw = p.get("params")
    if not raw:
        return None
    types = p.get("param_types") or {}
    out: dict[str, Any] = {}
    for name, value in raw.items():
        if types.get(name) == "date" and isinstance(value, str):
            try:
                value = dt.date.fromisoformat(value)
            except ValueError as e:
                raise ValueError(f"parameter {name!r}: {value!r} is not a date (YYYY-MM-DD)") from e
        out[name] = value
    return out
