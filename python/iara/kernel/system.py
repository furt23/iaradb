"""``system.publish``: a JSON-lines file written as one zstd Parquet file, at a path or an ``s3://`` URL."""

from __future__ import annotations

import os
from typing import Any

import pyarrow as pa
import pyarrow.json as pj
import pyarrow.parquet as pq

from iara import storage
from iara.kernel.extract import scratch

TYPES = {"string": pa.string(), "int": pa.int64(), "float": pa.float64(), "bool": pa.bool_(), "timestamp": pa.timestamp("ms")}


def _read(source: str, columns: list[tuple[str, str]]) -> pa.Table:
    # timestamps are unix milliseconds in the file: read as numbers, then cast
    schema = pa.schema([(name, pa.int64() if typ == "timestamp" else TYPES[typ]) for name, typ in columns])
    if os.path.isfile(source) and os.path.getsize(source) > 0:
        options = pj.ParseOptions(explicit_schema=schema, unexpected_field_behavior="ignore")
        table = pj.read_json(source, parse_options=options)
    else:
        table = schema.empty_table()
    return pa.table(
        [table[name].cast(pa.timestamp("ms")) if typ == "timestamp" else table[name] for name, typ in columns],
        names=[name for name, _ in columns],
    )


def publish(p: dict[str, Any]) -> dict[str, int]:
    """Write the rows of ``p["source"]`` (JSON lines) typed by ``p["columns"]`` to ``p["dest"]``: ``rows`` and ``bytes``."""
    columns = [(name, typ) for name, typ in p["columns"]]
    for _, typ in columns:
        if typ not in TYPES:
            raise ValueError(f"unknown column type {typ!r}: one of {', '.join(TYPES)}")
    table = _read(p["source"], columns)
    with scratch() as tmp:
        built = os.path.join(tmp, "publish.parquet")
        pq.write_table(table, built, compression="zstd")
        size = os.path.getsize(built)
        storage.copy_file(built, p["dest"])
    return {"rows": table.num_rows, "bytes": size}
