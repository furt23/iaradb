"""Result pages as Arrow IPC streams, for clients that decode them instead of parsing JSON rows.

Each column shows what the JSON pages show (see ``results.json_value``): the
types a browser decodes are kept as they are, everything else is text. A nested
value is JSON text, marked with the ``iara.cell`` field metadata.
"""

from __future__ import annotations

import base64
import json
from typing import Any

import pyarrow as pa
import pyarrow.compute as pc

from iara.kernel.runtime.results import MAX_SAFE_INT, json_value

#: field metadata of a column whose cells are JSON text (nested values)
JSON_CELL = {b"iara.cell": b"json"}
#: types a browser decodes as they are
KEPT = (
    pa.null(),
    pa.bool_(),
    pa.int8(),
    pa.int16(),
    pa.int32(),
    pa.uint8(),
    pa.uint16(),
    pa.uint32(),
    pa.float16(),
    pa.float32(),
    pa.float64(),
    pa.string(),
)


def display_table(table: pa.Table) -> pa.Table:
    """``table`` as a browser shows it: the values of the JSON pages, in types a browser decodes (names and order kept)."""
    fields, columns = [], []
    for field, column in zip(table.schema, table.columns):
        out, meta = _display(column)
        fields.append(pa.field(field.name, out.type, nullable=field.nullable, metadata=meta))
        columns.append(out)
    return pa.Table.from_arrays(columns, schema=pa.schema(fields))


def _display(column: pa.ChunkedArray) -> tuple[Any, dict[bytes, bytes] | None]:
    """A column as a browser shows it, and the field metadata it needs."""
    if pa.types.is_dictionary(column.type):
        column = pc.cast(column, column.type.value_type)
    t = column.type
    if t in KEPT:
        return column, None
    if pa.types.is_large_string(t) or pa.types.is_string_view(t):
        return pc.cast(column, pa.string()), None
    if t in (pa.int64(), pa.uint64()):
        # one type per column: if any value is past the safe range, the whole column is text
        mm = pc.min_max(column)
        lo, hi = mm["min"].as_py(), mm["max"].as_py()
        if lo is None or (-MAX_SAFE_INT <= lo and hi <= MAX_SAFE_INT):
            return column, None
        return pa.array([None if v is None else str(v) for v in column.to_pylist()], pa.string()), None
    values = [json_value(v) for v in column.to_pylist()]
    # a list or dict json_value gives (nested types, intervals) is JSON text too: pa.array would reject it
    if pa.types.is_nested(t) or any(x is not None and not isinstance(x, str) for x in values):
        text = [None if x is None else json.dumps(x, ensure_ascii=False, separators=(",", ":")) for x in values]
        return pa.array(text, pa.string()), JSON_CELL
    return pa.array(values, pa.string()), None


def ipc_page(table: pa.Table, offset: int, total: int, max_bytes: int = 16 * 2**20) -> dict[str, Any]:
    """A page (``table``, from row ``offset`` of ``total``) as a base64 Arrow IPC stream; fewer rows when
    the bytes would pass ``max_bytes`` (``rows`` says how many were sent)."""
    shown = display_table(table)
    data = _ipc(shown)
    while len(data) > max_bytes and shown.num_rows > 1:
        shown = shown.slice(0, shown.num_rows // 2)
        data = _ipc(shown)
    return {"offset": offset, "total": total, "rows": shown.num_rows, "data": base64.b64encode(data).decode("ascii")}


def _ipc(table: pa.Table) -> bytes:
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return sink.getvalue().to_pybytes()
