"""Tabular results kept by the kernel and served to clients page by page.

Results stay in the kernel as Arrow tables (large ones memory-mapped from
the spool, see ``spool.py``); clients only ever receive pages of JSON-safe
rows (64-bit integers beyond JavaScript's safe range, decimals, dates and
binary values are sent as strings).
"""

from __future__ import annotations

import base64
import datetime as dt
import decimal
import math
import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.compute as pc

from workhouse.kernel.runtime.spool import Spool

MAX_SAFE_INT = 2**53 - 1
DEFAULT_PAGE = 100


def json_value(v: Any) -> Any:
    if v is None or isinstance(v, (bool, str)):
        return v
    if isinstance(v, int):
        return v if -MAX_SAFE_INT <= v <= MAX_SAFE_INT else str(v)
    if isinstance(v, float):
        return v if math.isfinite(v) else str(v)
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, (decimal.Decimal, dt.timedelta)):
        return str(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        b = bytes(v)
        return "0x" + b[:64].hex() + ("…" if len(b) > 64 else "")
    if isinstance(v, dict):
        return {str(k): json_value(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [json_value(x) for x in v]
    return str(v)


def schema_view(schema: pa.Schema) -> list[dict[str, str]]:
    return [{"name": f.name, "type": str(f.type)} for f in schema]


@dataclass
class _Entry:
    table: pa.Table
    label: str
    #: the spool file of a large result
    path: Path | None = None
    sorted_key: tuple | None = None
    sorted_table: pa.Table | None = None
    sorted_path: Path | None = None


class ResultStore:
    """Most recent results, by id (least recently used are evicted)."""

    def __init__(self, capacity: int = 64, spool: Spool | None = None) -> None:
        self._entries: OrderedDict[str, _Entry] = OrderedDict()
        self._capacity = capacity
        self._lock = threading.Lock()
        self.spool = spool if spool is not None else Spool()

    def put(self, table: pa.Table, label: str = "", path: Path | None = None) -> dict[str, Any]:
        """Keep a result (``path``: its spool file, deleted with the result)."""
        rid = uuid.uuid4().hex[:12]
        evicted = []
        with self._lock:
            self._entries[rid] = _Entry(table, label, path)
            while len(self._entries) > self._capacity:
                evicted.append(self._entries.popitem(last=False)[1])
        for e in evicted:
            self.spool.remove(e.path)
            self.spool.remove(e.sorted_path)
        out = {"id": rid, "columns": schema_view(table.schema), "num_rows": table.num_rows, "page": self.page(rid, 0, DEFAULT_PAGE)}
        if path is not None:
            out["on_disk"] = True
        return out

    def get(self, rid: str) -> pa.Table:
        with self._lock:
            entry = self._entries.get(rid)
            if entry is None:
                raise KeyError(f"result {rid!r} is no longer available; re-run the cell")
            self._entries.move_to_end(rid)
            return entry.table

    def _sorted(self, rid: str, sort: list[dict[str, Any]]) -> pa.Table:
        key = tuple((s["column"], bool(s.get("descending"))) for s in sort)
        with self._lock:
            entry = self._entries[rid]
            if entry.sorted_key == key and entry.sorted_table is not None:
                return entry.sorted_table
            table = entry.table
        out, path = self._sort(table, key, large=entry.path is not None)
        with self._lock:
            old = entry.sorted_path
            entry.sorted_key, entry.sorted_table, entry.sorted_path = key, out, path
        self.spool.remove(old)
        return out

    def _sort(self, table: pa.Table, key: tuple, large: bool) -> tuple[pa.Table, Path | None]:
        """The table sorted (nulls last, ties in order); a large one by the
        engine, out of core, into the spool."""
        if not large:
            keys = [(c, "descending" if d else "ascending") for c, d in key]
            return table.take(pc.sort_indices(table, sort_keys=keys)), None
        import workhouse as wh

        lf = wh.from_arrow(table).lazy().sort([c for c, _ in key], descending=[d for _, d in key], nulls_last=True)
        spooled = self.spool.collect(lf.stream())
        return spooled.table, spooled.path

    def page(self, rid: str, offset: int = 0, limit: int = DEFAULT_PAGE, sort: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        table = self.get(rid)
        if sort:
            table = self._sorted(rid, sort)
        offset = max(0, min(offset, table.num_rows))
        rows = table.slice(offset, max(0, min(limit, 10_000))).to_pylist()
        names = table.column_names
        return {
            "offset": offset,
            "total": table.num_rows,
            "rows": [[json_value(r[n]) for n in names] for r in rows],
        }

    def export(self, rid: str, path: str, fmt: str) -> str:
        table = self.get(rid)
        if fmt == "csv":
            import pyarrow.csv as pcsv

            pcsv.write_csv(table, path)
        elif fmt == "parquet":
            import pyarrow.parquet as pq

            pq.write_table(table, path, compression="zstd")
        else:
            raise ValueError(f"unsupported export format {fmt!r}")
        return path


def image_payload(data: bytes | str, mime: str) -> dict[str, Any]:
    if isinstance(data, str):
        data = data.encode()
    return {"type": "image", "mime": mime, "data": base64.b64encode(data).decode()}
