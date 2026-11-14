"""Analyze: a query run with its profile and plan, for the Studio's Analyze screen.

The result is a ``QueryAnalysis`` (see ``packages/protocol``): the plan as a
tree of ``AnalyzedNode``s, the run's profile, the plan as text and the row
count (the rows themselves are not returned). When the engine's lazy query
offers ``analyze()`` (per-operator metrics, storage requests), its result is
used instead: its plan nodes may then carry ``metrics``.
"""

from __future__ import annotations

import time
from typing import Any

from iara.kernel.history import History, io_of
from iara.kernel.runtime.interrupt import Interruptor
from iara.workspaces import Workspace

#: the history source of analyzed runs
SOURCE = "analyze"


def analyzed_node(node: dict[str, Any]) -> dict[str, Any]:
    """A physical plan node (``explain_tree``) as an ``AnalyzedNode``."""
    return {
        "name": node.get("name", ""),
        "detail": node.get("detail", ""),
        "role": node.get("role"),
        "metrics": node.get("metrics"),
        "children": [analyzed_node(c) for c in node.get("children") or []],
    }


def run_profiled(lf: Any) -> dict[str, Any]:
    """Run a lazy query: ``{plan, profile, rows}`` and ``requests`` when the engine reports them."""
    if callable(getattr(lf, "analyze", None)):
        return lf.analyze()
    # counted as it streams: a result larger than memory is never held
    stream = lf.stream()
    rows = sum(b.num_rows for b in stream.batches())
    profile = stream.profile() or {}
    return {"plan": lf.explain_tree(), "profile": profile, "rows": rows, "requests": profile.get("requests")}


def analyze_query(
    ws: Workspace, query: str, history: History, interruptor: Interruptor, params: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Run a query with profiling; errors propagate as the query's own."""
    t0 = time.perf_counter()
    try:
        with interruptor.interruptible():
            lf = ws.sql(query, params=params) if params else ws.sql(query)
            run = run_profiled(lf)
    except BaseException as e:
        history.record(query, SOURCE, (time.perf_counter() - t0) * 1000, None, f"{type(e).__name__}: {e}", params)
        raise
    reads, writes = io_of(ws, [], run["profile"])
    history.record(
        query, SOURCE, run["profile"]["elapsed_ms"], run["rows"], params=params, profile=run["profile"], reads=reads, writes=writes
    )
    out: dict[str, Any] = {
        "query": query,
        "at": int(time.time() * 1000),
        "rows": run["rows"],
        "plan": analyzed_node(run["plan"]),
        "text": lf.explain(),
        "profile": run["profile"],
    }
    if run.get("requests") is not None:
        out["requests"] = run["requests"]
    return out
