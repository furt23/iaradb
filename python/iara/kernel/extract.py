"""Extracts: a dashboard dataset's result written as one Parquet file.

The query runs read-only under the request's ``allow`` list and streams from
the engine into a temporary local file. Only a file within ``max_bytes`` is
copied to its destination (a path or an ``s3://`` URL, through the engine's
own storage settings), so a result over the limit leaves nothing there, and a
refresh that fails keeps the extract it would have replaced.
"""

from __future__ import annotations

import os
import tempfile
import time
from typing import Any

import pyarrow.parquet as pq

from iara import storage
from iara.kernel.cell_runner import Emit, take_plans
from iara.kernel.history import History, io_of
from iara.kernel.runtime.interrupt import Interruptor
from iara.kernel.runtime.progress import watch
from iara.kernel.runtime.results import schema_view
from iara.workspaces import Workspace

MB = 1 << 20


def scratch() -> tempfile.TemporaryDirectory[str]:
    """A folder for the file being built: where the kernel keeps its large results."""
    root = os.environ.get("IARA_SPILL_DIR")
    if root:
        os.makedirs(root, exist_ok=True)
    return tempfile.TemporaryDirectory(prefix="iara-extract-", dir=root or None)


def write_extract(ws: Workspace, history: History, interruptor: Interruptor, p: dict[str, Any], emit: Emit) -> dict[str, Any]:
    """Write all the rows of ``p["query"]`` (read under ``p["allow"]``) to
    ``p["path"]``; raises if the file would pass ``p["max_bytes"]``.
    Returns ``rows``, ``bytes`` (the file's size), ``columns`` and ``sources``
    (the catalog tables the query read) and ``versions`` (table to version, when every read has both)."""
    query, path, max_bytes, source = p["query"], p["path"], int(p["max_bytes"]), p.get("source", "extract")
    t0 = time.perf_counter()
    ws.refresh()
    take_plans()  # runs left over from earlier cells are not this extract's
    try:
        ctx = ws.session.restricted(p["allow"])  # [] grants nothing, so no truthiness test
        with watch(lambda q: emit("progress", {"queries": q})), interruptor.interruptible(), scratch() as tmp:
            built = os.path.join(tmp, "extract.parquet")
            rows = ctx.sql(query).sink_parquet(built)
            runs = take_plans()
            reads, _ = io_of(ws, runs)
            size = os.path.getsize(built)
            if size > max_bytes:
                raise ValueError(
                    f"the extract is {size / MB:.1f} MB, over the {max_bytes / MB:.1f} MB limit: aggregate the dataset or make it live"
                )
            columns = schema_view(pq.read_schema(built))
            storage.copy_file(built, path)
    except BaseException as e:
        history.record(query, source, (time.perf_counter() - t0) * 1000, None, f"{type(e).__name__}: {e}")
        raise
    history.record(query, source, (time.perf_counter() - t0) * 1000, rows, reads=reads)
    # the same versions give the same rows only when the query reads nothing else: not the clock, not chance
    pinned = reads and all(r["table"] is not None and r["version"] is not None for r in reads) and not any(r["profile"].get("volatile") for r in runs)
    versions = {r["table"]: r["version"] for r in reads} if pinned else None
    return {"rows": rows, "bytes": size, "columns": columns, "sources": ctx.tables_read(), "versions": versions}
