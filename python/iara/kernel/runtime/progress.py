"""Stream progress of running Iara queries while a cell executes."""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

INTERVAL = 0.25


@contextmanager
def watch(emit: Callable[[list[dict[str, Any]]], None], interval: float = INTERVAL) -> Iterator[None]:
    """Call ``emit(queries)`` periodically with the running queries' progress."""
    import iara as ia

    stop = threading.Event()

    def loop() -> None:
        while not stop.wait(interval):
            queries = ia.running_queries()
            if queries:
                emit(queries)

    t = threading.Thread(target=loop, name="iara-progress", daemon=True)
    t.start()
    try:
        yield
    finally:
        stop.set()
        t.join()
