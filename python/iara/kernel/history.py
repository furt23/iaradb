"""Run history: each run the kernel makes is queued here and reported to the Studio as a ``history`` event."""

from __future__ import annotations

import threading
import time
from typing import Any

MAX_QUERY_CHARS = 20_000


def take_writes() -> list[dict[str, Any]]:
    """The engine's writes since the last call (none if the engine does not log them)."""
    import iara as ia

    take = getattr(ia, "take_writes", None)
    return take() if take else []


def _table_names(ws: Any) -> dict[str, str]:
    locate = getattr(getattr(ws, "session", None), "table_locations", None)
    return locate() if locate else {}


def io_of(ws: Any, runs: list[dict[str, Any]], profile: dict[str, Any] | None = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """The tables a run read (from its profile and its queries' profiles) and wrote (the engine's write log)."""
    reads: dict[tuple[str, int | None], dict[str, Any]] = {}
    # shortcut: the engine keeps the last 32 recorded runs, so a cell with more loses the oldest reads; raise RECORDED_MAX if lineage misses tables
    for p in [profile, *(r["profile"] for r in runs)]:
        for r in (p or {}).get("reads") or []:
            reads.setdefault((r["location"], r.get("version")), r)
    names = _table_names(ws)
    return (
        [{"table": names.get(r["location"]), "location": r["location"], "version": r.get("version")} for r in reads.values()],
        [
            {"table": names.get(w["location"]), "location": w["location"], "version": w.get("version"), "operation": w["operation"]}
            for w in take_writes()
        ],
    )


class History:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pending: list[dict[str, Any]] = []

    def record(
        self,
        query: str,
        source: str,
        elapsed_ms: float,
        rows: int | None,
        error: str | None = None,
        params: dict[str, Any] | None = None,
        *,
        kind: str = "sql",
        profile: dict[str, Any] | None = None,
        reads: Any = (),
        writes: Any = (),
    ) -> None:
        entry = {
            "ts": time.time(),
            "kind": kind,
            "query": query[:MAX_QUERY_CHARS],
            "source": source,
            "elapsed_ms": round(elapsed_ms, 2),
            "rows": rows,
            "error": error,
            "memory_peak": (profile or {}).get("memory_peak"),
            "spilled_bytes": (profile or {}).get("spilled_bytes"),
            "requests": (profile or {}).get("requests"),
            "reads": list(reads),
            "writes": list(writes),
        }
        if params:
            entry["params"] = params
        with self._lock:
            self._pending.append(entry)

    def drain(self) -> list[dict[str, Any]]:
        with self._lock:
            entries, self._pending = self._pending, []
        return entries
