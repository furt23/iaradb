"""Read options of CSV and JSON files, with Polars' names.

CSV (``scan_csv`` / ``read_csv`` / ``register_csv``): ``quote_char``,
``escape`` (DuckDB), ``null_values`` (a string or a list; the empty string is
always null), ``skip_rows``, ``comment`` (or Polars' ``comment_prefix``),
``columns`` (names to keep, in this order), ``schema_overrides`` (or
``dtypes``: ``{"col": "int64"}``), ``encoding`` (``"utf8"`` or
``"utf8-lossy"``) and ``try_parse_dates`` (default ``True``, unlike Polars:
Iara has always inferred dates; ``False`` keeps them as text).

JSON (``scan_ndjson`` / ``scan_json``): columns are bool, int64, float64 or
string; nested objects and arrays are struct and list columns (``nested="auto"``)
or, with ``nested="text"``, JSON *text* (a string column).
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence


def _strings(value: str | Sequence[str], what: str) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, Mapping):
        raise NotImplementedError(f"{what} as a per-column mapping is not supported: pass a string or a list")
    return [str(v) for v in value]


def csv_options(
    *,
    quote_char: str | None = '"',
    escape: str | None = None,
    null_values: str | Sequence[str] | None = None,
    skip_rows: int = 0,
    comment: str | None = None,
    comment_prefix: str | None = None,
    columns: Sequence[str] | None = None,
    schema_overrides: Mapping[str, Any] | None = None,
    dtypes: Mapping[str, Any] | None = None,
    encoding: str = "utf8",
    try_parse_dates: bool = True,
) -> dict[str, Any]:
    """The engine's option dict for the keyword arguments given."""
    o: dict[str, Any] = {"quote": quote_char or "", "encoding": encoding, "try_parse_dates": try_parse_dates}
    if escape:
        o["escape"] = escape
    comment = comment or comment_prefix
    if comment:
        o["comment"] = comment
    if null_values is not None:
        o["null_values"] = _strings(null_values, "null_values")
    if skip_rows:
        o["skip_rows"] = int(skip_rows)
    if columns is not None:
        o["columns"] = [str(c) for c in columns]
    types = {**(dtypes or {}), **(schema_overrides or {})}
    if types:
        o["schema_overrides"] = {str(k): str(v) for k, v in types.items()}
    return o


def json_options(*, infer_schema_length: int = 1000, parallel: bool = True, format: str = "auto", nested: str = "auto") -> dict[str, Any]:
    """``format`` is ``"auto"`` (by each file's first byte), ``"ndjson"`` or ``"array"``;
    ``nested`` is ``"auto"`` (struct and list columns) or ``"text"`` (JSON text)."""
    return {"infer_rows": int(infer_schema_length), "parallel": parallel, "format": format, "nested": nested}


JSON_EXTENSIONS = (".json", ".ndjson", ".jsonl")


def is_json_path(path: str) -> bool:
    return path.lower().endswith(JSON_EXTENSIONS)
