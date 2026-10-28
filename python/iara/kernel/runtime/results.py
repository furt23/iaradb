"""Tabular results kept by the kernel and served to clients page by page.

Results stay in the kernel as Arrow tables (large ones memory-mapped from
the spool, see ``spool.py``); clients receive each page as JSON-safe rows
(64-bit integers beyond JavaScript's safe range, decimals, dates and binary
values are sent as strings) or as an Arrow IPC stream of the same values
(see ``arrow_page.py``).

A preview keeps its first rows as the table (what the grid pages and sorts)
and the frame it came from as the source: downloads, charts and the
wrangler read all of it.
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

from iara.kernel.runtime.spool import Spool

MAX_SAFE_INT = 2**53 - 1
DEFAULT_PAGE = 100
#: rows a preview shows (the full result stays available to downloads)
PREVIEW_ROWS = 500


def _flat_for_csv(table: Any) -> Any:
    """CSV has no lists or structs: nested columns are written as JSON text."""
    import json

    import pyarrow as pa

    for i, field in enumerate(table.schema):
        if pa.types.is_nested(field.type):
            text = [None if v is None else json.dumps(json_value(v), ensure_ascii=False) for v in table.column(i).to_pylist()]
            table = table.set_column(i, pa.field(field.name, pa.string()), pa.array(text, pa.string()))
    return table


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
    #: all the rows (a iara DataFrame or LazyFrame, or an Arrow table) when ``table`` holds only the first ones
    source: Any = None
    #: the full collected source, once something needed it as a table
    full_table: pa.Table | None = None


class ResultStore:
    """Most recent results, by id (least recently used are evicted)."""

    def __init__(self, capacity: int = 64, spool: Spool | None = None) -> None:
        self._entries: OrderedDict[str, _Entry] = OrderedDict()
        self._capacity = capacity
        self._lock = threading.Lock()
        # pages are read on a pool: one sort at a time, so two never race on the spooled copy
        self._sorting = threading.Lock()
        self.spool = spool if spool is not None else Spool()

    def put(
        self, table: pa.Table, label: str = "", path: Path | None = None, source: Any = None, total: int | None = None
    ) -> dict[str, Any]:
        """Keep a result (``path``: its spool file, deleted with the result).
        ``source``: all the rows when ``table`` holds the first ones; ``total``:
        how many there are, when known."""
        rid = uuid.uuid4().hex[:12]
        evicted = []
        with self._lock:
            self._entries[rid] = _Entry(table, label, path, source=source)
            while len(self._entries) > self._capacity:
                evicted.append(self._entries.popitem(last=False)[1])
        for e in evicted:
            self.spool.remove(e.path)
            self.spool.remove(e.sorted_path)
        out = {"id": rid, "columns": schema_view(table.schema), "num_rows": table.num_rows, "page": self.page(rid, 0, DEFAULT_PAGE)}
        if path is not None:
            out["on_disk"] = True
        if source is not None:
            out["truncated"] = True
            out["total_rows"] = total
        return out

    def _entry(self, rid: str) -> _Entry:
        with self._lock:
            entry = self._entries.get(rid)
            if entry is None:
                raise KeyError(f"result {rid!r} is no longer available; re-run the cell")
            self._entries.move_to_end(rid)
            return entry

    def full(self, rid: str) -> Any:
        """All the rows of a result, as something ``ws.sql`` takes as a table
        (a LazyFrame stays lazy)."""
        entry = self._entry(rid)
        return entry.table if entry.source is None else entry.source

    def full_table(self, rid: str) -> pa.Table:
        """All the rows of a result as an Arrow table (a lazy source runs once)."""
        entry = self._entry(rid)
        if entry.source is None:
            return entry.table
        if entry.full_table is None:
            entry.full_table = _arrow(entry.source)
        return entry.full_table

    def get(self, rid: str) -> pa.Table:
        with self._lock:
            entry = self._entries.get(rid)
            if entry is None:
                raise KeyError(f"result {rid!r} is no longer available; re-run the cell")
            self._entries.move_to_end(rid)
            return entry.table

    def _sorted(self, rid: str, sort: list[dict[str, Any]]) -> pa.Table:
        key = tuple((s["column"], bool(s.get("descending"))) for s in sort)
        with self._sorting:
            return self._sorted_locked(rid, key)

    def _sorted_locked(self, rid: str, key: tuple) -> pa.Table:
        with self._lock:
            entry = self._entries[rid]
            if entry.sorted_key == key and entry.sorted_table is not None:
                return entry.sorted_table
            table = entry.table
        if entry.source is not None:
            # a preview sorts all the rows and shows the first ones (a top-k in the engine)
            out, path = _top(entry.source, key, table.num_rows), None
        else:
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
        import iara as ia

        lf = ia.from_arrow(table).lazy().sort([c for c, _ in key], descending=[d for _, d in key], nulls_last=True)
        spooled = self.spool.collect(lf.stream())
        return spooled.table, spooled.path

    def _slice(self, rid: str, offset: int, limit: int, sort: list[dict[str, Any]] | None) -> tuple[pa.Table, int, int]:
        """The rows of a page (sorted first when ``sort`` is given), the clamped offset and the number of rows in the result."""
        table = self.get(rid)
        if sort:
            table = self._sorted(rid, sort)
        offset = max(0, min(offset, table.num_rows))
        return table.slice(offset, max(0, min(limit, 10_000))), offset, table.num_rows

    def page(self, rid: str, offset: int = 0, limit: int = DEFAULT_PAGE, sort: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        rows, offset, total = self._slice(rid, offset, limit, sort)
        names = rows.column_names
        return {
            "offset": offset,
            "total": total,
            "rows": [[json_value(r[n]) for n in names] for r in rows.to_pylist()],
        }

    def arrow_page(self, rid: str, offset: int = 0, limit: int = DEFAULT_PAGE, sort: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        """The rows ``page`` returns, as an Arrow IPC stream (see ``arrow_page.py``)."""
        from iara.kernel.runtime.arrow_page import ipc_page  # a module-level import would be circular

        rows, offset, total = self._slice(rid, offset, limit, sort)
        return ipc_page(rows, offset, total)

    def export(self, rid: str, path: str, fmt: str) -> str:
        """Write all the rows (not only the previewed ones); a lazy source is
        streamed batch by batch."""
        if fmt not in ("csv", "parquet"):
            raise ValueError(f"unsupported export format {fmt!r}")
        entry = self._entry(rid)
        import iara as ia

        if isinstance(entry.source, ia.LazyFrame) and entry.full_table is None:
            reader = entry.source.to_reader()
            batches = (pa.Table.from_batches([b]) for b in reader)
            _write(batches, reader.schema, path, fmt)
        else:
            table = self.full_table(rid)
            _write(iter([table]), table.schema, path, fmt)
        return path


def _top(source: Any, key: tuple, n: int) -> pa.Table:
    """The first ``n`` rows of ``source`` sorted by ``key`` (nulls last)."""
    import iara as ia

    lf = source if isinstance(source, ia.LazyFrame) else (source if isinstance(source, ia.DataFrame) else ia.from_arrow(source)).lazy()
    return lf.sort([c for c, _ in key], descending=[d for _, d in key], nulls_last=True).limit(n).collect().to_arrow()


def _arrow(source: Any) -> pa.Table:
    import iara as ia

    if isinstance(source, ia.LazyFrame):
        return source.collect().to_arrow()
    if isinstance(source, ia.DataFrame):
        return source.to_arrow()
    return source


def _write(tables: Any, schema: pa.Schema, path: str, fmt: str) -> None:
    """Write Arrow tables one after the other into a CSV or Parquet file."""
    if fmt == "csv":
        import pyarrow.csv as pcsv

        writer = None
        try:
            for t in tables:
                t = _flat_for_csv(t)
                if writer is None:
                    writer = pcsv.CSVWriter(path, t.schema)
                writer.write_table(t)
            if writer is None:  # no rows: the header alone
                pcsv.write_csv(_flat_for_csv(schema.empty_table()), path)
        finally:
            if writer is not None:
                writer.close()
        return
    import pyarrow.parquet as pq

    with pq.ParquetWriter(path, schema, compression="zstd") as writer:
        for t in tables:
            writer.write_table(t)


def image_payload(data: bytes | str, mime: str) -> dict[str, Any]:
    if isinstance(data, str):
        data = data.encode()
    return {"type": "image", "mime": mime, "data": base64.b64encode(data).decode()}
