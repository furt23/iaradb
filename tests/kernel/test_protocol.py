"""The kernel as a subprocess speaking JSON lines over stdio."""

from __future__ import annotations

import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from workhouse.kernel import PROTOCOL_VERSION


class KernelProcess:
    def __init__(self, workspace: Path) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "workhouse.kernel", "--workspace", str(workspace)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.messages: queue.Queue[dict[str, Any]] = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        self._next = 0

    def _read(self) -> None:
        for line in self.proc.stdout:
            self.messages.put(json.loads(line))

    def send(self, method: str, params: dict | None = None) -> int:
        self._next += 1
        msg = {"id": self._next, "method": method, "params": params or {}}
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        self.proc.stdin.flush()
        return self._next

    def wait(self, rid: int, timeout: float = 30) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """(response, events of that request)."""
        events = []
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            msg = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
            if msg.get("id") == rid:
                return msg, events
            if msg.get("request") == rid:
                events.append(msg)
        raise TimeoutError(f"no response to request {rid}")

    def call(self, method: str, params: dict | None = None) -> Any:
        resp, _ = self.wait(self.send(method, params))
        assert "error" not in resp, resp
        return resp["result"]

    def close(self) -> None:
        if self.proc.poll() is None:
            self.send("shutdown")
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()


@pytest.fixture()
def kernel(workspace: Path):
    k = KernelProcess(workspace)
    ready = k.messages.get(timeout=30)
    assert ready["event"] == "kernel.ready" and ready["data"]["name"] == "demo"
    yield k
    k.close()


def test_ping_and_unknown_method(kernel: KernelProcess):
    assert kernel.call("ping")["protocol"] == PROTOCOL_VERSION
    resp, _ = kernel.wait(kernel.send("nope"))
    assert resp["error"]["type"] == "LookupError"


def test_run_streams_events(kernel: KernelProcess):
    view = kernel.call("notebook.create", {"path": "notebooks/p.py"})
    cells = view["cells"] + [
        {"id": "s", "kind": "sql", "code": "select grp, count(*) c from sales group by grp", "output": "g"},
        {"id": "p", "kind": "python", "code": "print('rows', g.height)"},
    ]
    resp, events = kernel.wait(kernel.send("notebook.run", {"cells": cells, "cell_ids": ["p"]}))
    assert resp["result"]["interrupted"] is False
    kinds = [(e["event"], e["data"].get("status")) for e in events]
    assert ("cell.state", "running") in kinds and ("cell.stream", None) in kinds
    final = [e["data"] for e in events if e["event"] == "cell.state" and e["data"]["cell_id"] == "s"][-1]
    assert final["status"] == "done" and final["output"]["result"]["num_rows"] == 7
    page = kernel.call("result.page", {"result_id": final["output"]["result"]["id"], "offset": 0, "limit": 2})
    assert page["total"] == 7 and len(page["rows"]) == 2


def test_print_to_fd1_does_not_corrupt_protocol(kernel: KernelProcess):
    kernel.call("notebook.create", {"path": "notebooks/q.py"})
    code = "import os\nos.write(1, b'raw bytes on fd 1\\n')\nprint('hello')"
    kernel.call("notebook.run", {"cells": [{"id": "c", "kind": "python", "code": code}]})
    assert kernel.call("ping")["protocol"] == PROTOCOL_VERSION


def test_interrupt_is_answered_while_running(kernel: KernelProcess):
    kernel.call("notebook.create", {"path": "notebooks/r.py"})
    run_id = kernel.send("notebook.run", {"cells": [{"id": "loop", "kind": "python", "code": "import time\nwhile True:\n    time.sleep(0.01)"}]})
    time.sleep(0.5)
    assert kernel.call("ping")["protocol"] == PROTOCOL_VERSION  # immediate methods answer during the run
    t0 = time.monotonic()
    assert kernel.call("interrupt")["interrupted"] is True
    resp, _ = kernel.wait(run_id, timeout=10)
    assert resp["result"]["interrupted"] is True
    assert time.monotonic() - t0 < 5


def test_assist_is_answered_while_running(kernel: KernelProcess):
    kernel.call("notebook.create", {"path": "notebooks/s.py"})
    run_id = kernel.send("notebook.run", {"cells": [{"id": "loop", "kind": "python", "code": "import time\nwhile True:\n    time.sleep(0.01)"}]})
    time.sleep(0.3)
    code = "import os\nos.pa"
    out = kernel.call("assist.complete", {"code": code, "cursor": len(code), "cell_id": "x"})
    assert "path" in [i["label"] for i in out["items"]]
    assert kernel.call("assist.lint", {"code": "x = (", "kind": "python", "cell_id": "x"})[0]["severity"] == "error"
    kernel.call("interrupt")
    kernel.wait(run_id, timeout=10)
