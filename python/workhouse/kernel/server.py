"""Request dispatch: immediate methods on the reader thread, user code on a
single worker thread (so ``interrupt`` is always answered right away), code
assistance on a thread of its own (so completions keep working while a cell
runs), and slower reads on a small pool."""

from __future__ import annotations

import queue
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from workhouse.kernel.protocol import Channel
from workhouse.kernel.session import ASSIST, BACKGROUND, QUEUED, Handler, KernelSession

_STOP = object()


class KernelServer:
    def __init__(self, channel: Channel, session: KernelSession) -> None:
        self.channel = channel
        self.session = session
        self.handlers = session.handlers()
        self._queue: queue.Queue[Any] = queue.Queue()
        self._worker = threading.Thread(target=self._work, name="workhouse-kernel-worker", daemon=True)
        self._assist: queue.Queue[Any] = queue.Queue()
        #: newest request id per (method, cell): older pending ones are skipped
        self._latest: dict[tuple[str, Any], Any] = {}
        self._assistant = threading.Thread(target=self._assist_work, name="workhouse-kernel-assist", daemon=True)
        self._pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="workhouse-kernel-read")

    def _call(self, rid: Any, handler: Handler, params: dict[str, Any]) -> None:
        def emit(event: str, data: dict[str, Any]) -> None:
            self.channel.event(event, data, rid)

        try:
            result = handler(params, emit)
        except BaseException as e:  # noqa: BLE001 - reported to the client
            self.channel.fail(rid, e)
        else:
            self.channel.respond(rid, result)

    def _work(self) -> None:
        while True:
            item = self._queue.get()
            if item is _STOP:
                return
            self._call(*item)

    def _assist_work(self) -> None:
        while True:
            item = self._assist.get()
            if item is _STOP:
                return
            rid, handler, params, key = item
            if self._latest.get(key) != rid:
                self.channel.respond(rid, None)  # superseded by a newer request
                continue
            self._call(rid, handler, params)

    @staticmethod
    def _warm_up() -> None:
        """Import marimo in the background: notebooks' setup cells import it,
        and it takes seconds (an import in progress is simply waited for)."""
        try:
            import marimo  # noqa: F401
        except ImportError:
            pass
        try:
            import jedi  # noqa: F401 - the first completion would wait for it
        except ImportError:
            pass

    def serve(self) -> None:
        threading.Thread(target=self._warm_up, name="workhouse-warm-up", daemon=True).start()
        self._worker.start()
        self._assistant.start()
        self.channel.event("kernel.ready", self.session.info())
        try:
            for msg in self.channel.messages():
                rid, method = msg.get("id"), msg.get("method")
                params = msg.get("params") or {}
                if method == "shutdown":
                    self.channel.respond(rid, {"ok": True})
                    break
                handler = self.handlers.get(method)
                if handler is None:
                    self.channel.fail(rid, LookupError(f"unknown method {method!r}"))
                elif method in QUEUED:
                    self._queue.put((rid, handler, params))
                elif method in ASSIST:
                    key = (method, params.get("cell_id"))
                    self._latest[key] = rid
                    self._assist.put((rid, handler, params, key))
                elif method in BACKGROUND:
                    self._pool.submit(self._call, rid, handler, params)
                else:
                    self._call(rid, handler, params)
        finally:
            self.session.interruptor.interrupt()
            self._queue.put(_STOP)
            self._assist.put(_STOP)
            self._pool.shutdown(wait=False, cancel_futures=True)
