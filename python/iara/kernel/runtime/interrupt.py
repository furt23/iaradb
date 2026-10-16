"""Interrupting running cells from another thread.

Two mechanisms cover the two places a cell can be busy: Iara queries are
cancelled through the engine (they run outside the interpreter with the GIL
released), and Python code receives an asynchronous ``KeyboardInterrupt``.
"""

from __future__ import annotations

import ctypes
import threading
from collections.abc import Iterator
from contextlib import contextmanager


def _set_async_exc(thread_id: int, exc: type[BaseException] | None) -> None:
    obj = ctypes.py_object(exc) if exc is not None else None  # NULL clears a pending one
    ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(thread_id), obj)


class Interruptor:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: int | None = None

    @contextmanager
    def interruptible(self) -> Iterator[None]:
        """Mark the calling thread as running user code that may be interrupted."""
        with self._lock:
            self._thread = threading.get_ident()
        try:
            yield
        finally:
            with self._lock:
                self._thread = None
                # an interrupt that arrived as the code finished must not
                # surface later inside the kernel
                _set_async_exc(threading.get_ident(), None)

    @property
    def busy(self) -> bool:
        return self._thread is not None

    def interrupt(self) -> bool:
        """Cancel running queries and interrupt running Python code."""
        import iara as ia

        ia.interrupt()
        with self._lock:
            if self._thread is None:
                return False
            _set_async_exc(self._thread, KeyboardInterrupt)
            return True
