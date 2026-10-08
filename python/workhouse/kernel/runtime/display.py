"""Turn the value a cell produced into an output payload for the client.

Payload types: ``table`` (a stored result, plus run profile and plan for lazy
queries), ``html``, ``image``, ``text`` and ``error``.
"""

from __future__ import annotations

import traceback
from pathlib import Path
from typing import Any

import pyarrow as pa

from workhouse.kernel.runtime.results import ResultStore, image_payload

MAX_TEXT = 20_000


def to_arrow(value: Any) -> pa.Table | None:
    """An Arrow table for table-like values (Workhouse, pyarrow, pandas, polars)."""
    import workhouse as wh

    if isinstance(value, wh.DataFrame):
        return value.to_arrow()
    if isinstance(value, pa.Table):
        return value
    if isinstance(value, pa.RecordBatch):
        return pa.Table.from_batches([value])
    module = type(value).__module__.split(".")[0]
    if module == "polars" and hasattr(value, "to_arrow"):
        return value.to_arrow()
    if module == "pandas" and type(value).__name__ == "DataFrame":
        return pa.Table.from_pandas(value, preserve_index=False)
    if hasattr(value, "__arrow_c_stream__") and not isinstance(value, type):
        return pa.RecordBatchReader.from_stream(value).read_all()
    return None


def table_output(store: ResultStore, table: pa.Table, label: str, profile: dict | None = None, plan: dict | None = None, path: Path | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"type": "table", "result": store.put(table, label, path)}
    if profile is not None:
        out["profile"] = profile
    if plan is not None:
        out["plan"] = plan
    return out


def run_query(store: ResultStore, lf: Any, label: str) -> tuple[dict[str, Any], Any]:
    """Run a query, spooling a large result to disk: ``(table output, DataFrame)``."""
    import workhouse as wh

    plan = lf.explain_tree()
    spooled = store.spool.collect(lf.stream())
    output = table_output(store, spooled.table, label, spooled.profile, plan, spooled.path)
    return output, wh.from_arrow(spooled.table)


def display(value: Any, store: ResultStore, label: str = "") -> dict[str, Any] | None:
    """Output payload of a value, or None for nothing to show."""
    import workhouse as wh

    if value is None:
        return None
    if isinstance(value, wh.LazyFrame):
        return run_query(store, value, label)[0]
    table = to_arrow(value)
    if table is not None:
        return table_output(store, table, label)
    mime = getattr(value, "_mime_", None)
    if callable(mime):  # marimo outputs (mo.md, mo.ui ...)
        kind, data = mime()
        if kind.startswith("image/"):
            return image_payload(data, kind)
        if kind == "text/html":
            return {"type": "html", "html": str(data)}
        return {"type": "text", "text": str(data)[:MAX_TEXT]}
    for attr, kind in (("_repr_png_", "image/png"), ("_repr_svg_", "image/svg+xml")):
        fn = getattr(value, attr, None)
        if callable(fn) and (data := fn()) is not None:
            return image_payload(data, kind)
    html = getattr(value, "_repr_html_", None)
    if callable(html) and (h := html()) is not None:
        return {"type": "html", "html": str(h)}
    text = repr(value)
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT] + f"\n… ({len(text) - MAX_TEXT} more characters)"
    return {"type": "text", "text": text}


def error_output(exc: BaseException, filename: str | None = None) -> dict[str, Any]:
    """An error payload; traceback frames from kernel internals are dropped
    (engine errors need none: their message says it all)."""
    import workhouse as wh

    if isinstance(exc, wh.WorkhouseError):
        return {"type": "error", "ename": type(exc).__name__, "evalue": str(exc), "traceback": ""}
    frames = traceback.extract_tb(exc.__traceback__)
    if filename is not None:
        user = [f for f in frames if f.filename == filename]
        frames = traceback.StackSummary.from_list(user) if user else frames
    lines = traceback.format_list(frames) + traceback.format_exception_only(type(exc), exc)
    return {"type": "error", "ename": type(exc).__name__, "evalue": str(exc), "traceback": "".join(lines)}
