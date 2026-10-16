"""JSON-lines protocol over the kernel process's stdin and stdout.

Client → kernel, one JSON object per line::

    {"id": 7, "method": "notebook.run", "params": {...}}

Kernel → client::

    {"id": 7, "result": ...}                                  # success
    {"id": 7, "error": {"type": "...", "message": "..."}}     # failure
    {"event": "cell.state", "request": 7, "data": {...}}      # progress of request 7

The original stdin/stdout are reserved for the protocol: user code reads an
empty stdin, and anything written to file descriptor 1 (by native code, for
example) is redirected to stderr, so it can never corrupt the stream.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from collections.abc import Iterator
from typing import Any, BinaryIO


class Channel:
    def __init__(self, inp: BinaryIO, out: BinaryIO) -> None:
        self._in = inp
        self._out = out
        self._lock = threading.Lock()

    @staticmethod
    def over_stdio() -> Channel:
        """Take over the process's stdio for the protocol."""
        inp = os.fdopen(os.dup(0), "rb")
        out = os.fdopen(os.dup(1), "wb")
        null = os.open(os.devnull, os.O_RDONLY)
        os.dup2(null, 0)
        os.close(null)
        os.dup2(2, 1)
        sys.stdin = open(os.devnull, encoding="utf-8")  # noqa: SIM115
        sys.stdout = sys.stderr
        return Channel(inp, out)

    def messages(self) -> Iterator[dict[str, Any]]:
        for line in self._in:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as e:
                self.send({"id": None, "error": {"type": "ProtocolError", "message": f"invalid JSON: {e}"}})
                continue
            if isinstance(msg, dict):
                yield msg

    def send(self, msg: dict[str, Any]) -> None:
        data = (json.dumps(msg, default=str, separators=(",", ":")) + "\n").encode("utf-8")
        with self._lock:
            self._out.write(data)
            self._out.flush()

    def respond(self, rid: Any, result: Any) -> None:
        self.send({"id": rid, "result": result})

    def fail(self, rid: Any, exc: BaseException) -> None:
        self.send({"id": rid, "error": {"type": type(exc).__name__, "message": str(exc)}})

    def event(self, name: str, data: dict[str, Any], request: Any = None) -> None:
        self.send({"event": name, "request": request, "data": data})
