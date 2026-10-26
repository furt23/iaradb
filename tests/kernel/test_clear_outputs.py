"""Clearing outputs in the kernel: they do not come back when the notebook is reopened."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from iara.kernel.session import KernelSession


@pytest.fixture()
def session(workspace: Path):
    cwd = os.getcwd()
    s = KernelSession(workspace)
    yield s
    os.chdir(cwd)


def py(cid: str, code: str) -> dict[str, Any]:
    return {"id": cid, "kind": "python", "code": code}


def call(session: KernelSession, method: str, params: dict[str, Any]) -> Any:
    return session.handlers()[method](params, lambda *a: None)


def open_with_outputs(session: KernelSession) -> None:
    call(session, "notebook.create", {"path": "notebooks/clear.py", "persist": False})
    cells = [py("a", "a = 1\na"), py("b", "print('hi')\nb = a + 1\nb")]
    session.notebook.run(cells, None, lambda *a: None)
    states = session.notebook.view()["states"]
    assert states["a"]["output"] == {"type": "text", "text": "1"}
    assert states["b"]["streams"] == [{"stream": "stdout", "text": "hi\n"}]


def test_clear_resets_the_chosen_cells_only(session: KernelSession):
    open_with_outputs(session)
    result = call(session, "notebook.clear", {"path": "notebooks/clear.py", "cells": ["a"]})
    assert result == {"cleared": 1}
    states = session.notebook.view()["states"]
    assert states["a"] == {
        "status": "idle", "stale": False, "output": None, "streams": [], "elapsed_ms": None, "frames": [], "queries": []
    }
    assert states["b"]["status"] == "done" and states["b"]["output"] == {"type": "text", "text": "2"}


def test_reopening_after_a_clear_shows_no_outputs(session: KernelSession):
    open_with_outputs(session)
    call(session, "notebook.clear", {"path": "notebooks/clear.py", "cells": None})
    # the Studio reopens the notebook on reload: the kernel answers with its states
    reopened = call(session, "notebook.open", {"path": "notebooks/clear.py"})
    assert all(s["output"] is None and s["streams"] == [] and s["status"] == "idle" for s in reopened["states"].values())


def test_clear_keeps_the_values_cells_defined(session: KernelSession):
    open_with_outputs(session)
    call(session, "notebook.clear", {"path": "notebooks/clear.py", "cells": None})
    assert session.notebook.namespace()["a"] == 1
    assert "a" in {v["name"] for v in session.notebook.variables()}


def test_clear_skips_queued_and_running_cells(session: KernelSession):
    open_with_outputs(session)
    session.notebook.states["b"].status = "running"
    result = call(session, "notebook.clear", {"path": "notebooks/clear.py", "cells": None})
    assert result == {"cleared": 1}
    assert session.notebook.states["b"].status == "running"
    assert session.notebook.states["a"].status == "idle"


def test_clear_ignores_another_notebook(session: KernelSession):
    open_with_outputs(session)
    result = call(session, "notebook.clear", {"path": "notebooks/other.py", "cells": None})
    assert result == {"cleared": 0}
    assert session.notebook.view()["states"]["a"]["output"] == {"type": "text", "text": "1"}


def test_clear_without_an_open_notebook_does_nothing(session: KernelSession):
    assert call(session, "notebook.clear", {"path": "notebooks/clear.py", "cells": None}) == {"cleared": 0}
