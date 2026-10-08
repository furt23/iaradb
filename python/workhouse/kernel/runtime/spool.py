"""Query results kept on disk when they are large.

A result is read batch by batch while its query runs. Results up to
``WORKHOUSE_RESULT_MEMORY`` (default 128MB) stay in memory. Larger ones go
to an uncompressed Arrow IPC file in the kernel's spool folder and are
memory-mapped back: a result larger than RAM can still be paged through,
sorted (by the engine, out of core) and exported. The DataFrame bound to the
cell's output variable shares those mapped buffers.
"""

from __future__ import annotations

import atexit
import contextlib
import os
import re
import shutil
import tempfile
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pyarrow as pa

import workhouse as wh

DEFAULT_MEMORY = 128 << 20
_UNITS = {"": 1, "B": 1, "K": 1 << 10, "KB": 1 << 10, "M": 1 << 20, "MB": 1 << 20, "G": 1 << 30, "GB": 1 << 30, "T": 1 << 40, "TB": 1 << 40}


def parse_size(raw: str) -> int:
    """``"134217728"``, ``"512MB"``, ``"1.5GB"`` -> bytes."""
    m = re.fullmatch(r"\s*([0-9]*\.?[0-9]+)\s*([KMGT]?B?)\s*", raw.upper())
    if m is None:
        raise ValueError(f"invalid size {raw!r} (expected bytes or a unit like 512MB)")
    return int(float(m.group(1)) * _UNITS[m.group(2)])


def memory_threshold() -> int:
    raw = os.environ.get("WORKHOUSE_RESULT_MEMORY")
    return parse_size(raw) if raw else DEFAULT_MEMORY


@dataclass
class Spooled:
    table: pa.Table
    #: the file holding the table (None: in memory)
    path: Path | None
    profile: dict[str, Any] | None


class Spool:
    """The kernel's folder of on-disk results (removed when the kernel exits)."""

    def __init__(self, threshold: int | None = None, root: str | None = None) -> None:
        self.threshold = memory_threshold() if threshold is None else threshold
        self._root = root if root is not None else os.environ.get("WORKHOUSE_SPILL_DIR")
        self._dir: Path | None = None
        self._lock = threading.Lock()

    def _new_path(self) -> Path:
        with self._lock:
            if self._dir is None:
                if self._root:
                    os.makedirs(self._root, exist_ok=True)
                self._dir = Path(tempfile.mkdtemp(prefix="workhouse-results-", dir=self._root or None))
                atexit.register(self.close)
            return self._dir / f"{uuid.uuid4().hex}.arrow"

    def collect(self, stream: wh.ResultStream) -> Spooled:
        """Read a query's result to the end, in memory or (when large) on disk."""
        schema = stream.schema
        held: list[pa.RecordBatch] = []
        size = 0
        path: Path | None = None
        writer: Any = None
        try:
            for batch in stream.batches():
                if writer is not None:
                    writer.write_batch(batch)
                    continue
                held.append(batch)
                size += batch.nbytes
                if size > self.threshold:
                    path = self._new_path()
                    writer = pa.ipc.new_file(str(path), schema)
                    for b in held:
                        writer.write_batch(b)
                    held = []
            if writer is None:
                return Spooled(pa.Table.from_batches(held, schema), None, stream.profile())
            writer.close()
            writer = None
            table = pa.ipc.open_file(pa.memory_map(str(path))).read_all()
            return Spooled(table, path, stream.profile())
        except BaseException:
            if writer is not None:
                writer.close()
            self.remove(path)
            raise

    def remove(self, path: Path | None) -> None:
        """Delete a result's file (on Windows a file still mapped stays until exit)."""
        if path is not None:
            with contextlib.suppress(OSError):
                path.unlink()

    def close(self) -> None:
        if self._dir is not None:
            shutil.rmtree(self._dir, ignore_errors=True)
