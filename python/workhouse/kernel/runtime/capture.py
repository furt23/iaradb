"""Capture what a cell prints, streaming it out as it is written."""

from __future__ import annotations

import io
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager

MAX_STREAM = 1 << 20


class StreamWriter(io.TextIOBase):
    """A text stream that forwards writes to a callback (up to a size cap)."""

    def __init__(self, name: str, sink: Callable[[str, str], None]) -> None:
        self.name = name
        self._sink = sink
        self._written = 0

    def writable(self) -> bool:
        return True

    def write(self, s: str) -> int:
        if not s:
            return 0
        if self._written < MAX_STREAM:
            chunk = s[: MAX_STREAM - self._written]
            self._written += len(chunk)
            self._sink(self.name, chunk if len(chunk) == len(s) else chunk + "\n… output truncated\n")
        return len(s)

    def flush(self) -> None:
        pass


@contextmanager
def capture(sink: Callable[[str, str], None]) -> Iterator[None]:
    """Redirect ``sys.stdout`` / ``sys.stderr`` to ``sink(stream, text)``."""
    saved = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = StreamWriter("stdout", sink), StreamWriter("stderr", sink)
    try:
        yield
    finally:
        sys.stdout, sys.stderr = saved
