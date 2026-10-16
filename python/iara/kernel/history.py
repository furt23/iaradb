"""Query history of a workspace, kept in ``.iara/history.jsonl``."""

from __future__ import annotations

import json
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

MAX_QUERY_CHARS = 20_000


class History:
    def __init__(self, root: Path) -> None:
        self.path = root / ".iara" / "history.jsonl"
        self._lock = threading.Lock()

    def record(
        self,
        query: str,
        source: str,
        elapsed_ms: float,
        rows: int | None,
        error: str | None = None,
        params: dict[str, Any] | None = None,
    ) -> None:
        entry = {
            "ts": time.time(),
            "query": query[:MAX_QUERY_CHARS],
            "source": source,
            "elapsed_ms": round(elapsed_ms, 2),
            "rows": rows,
            "error": error,
        }
        if params:
            entry["params"] = params
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, default=str) + "\n")

    def recent(self, limit: int = 200) -> list[dict[str, Any]]:
        if not self.path.is_file():
            return []
        with self._lock, open(self.path, encoding="utf-8") as f:
            lines = deque(f, maxlen=limit)
        out = []
        for line in reversed(lines):
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out
