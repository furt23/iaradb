"""Catalog browsing: table listings, schemas, sizes and Parquet statistics.

Files are listed and statistics read by the engine, so local paths and
object store URLs (``s3://...``) are browsed the same way.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from workhouse.storage import list_files
from workhouse.workspaces import TableSpec, Workspace


def _relative(ws: Workspace, spec: TableSpec) -> str:
    if spec.remote:
        return spec.path
    path = Path(spec.path)
    try:
        return path.relative_to(ws.root).as_posix()
    except ValueError:
        return path.as_posix()


def spec_view(ws: Workspace, spec: TableSpec) -> dict[str, Any]:
    return {"name": spec.name, "path": _relative(ws, spec), "format": spec.format}


def list_tables(ws: Workspace) -> list[dict[str, Any]]:
    return [spec_view(ws, t) for t in ws.tables]


def schemas(ws: Workspace) -> dict[str, list[dict[str, str]]]:
    """Columns of every catalog table (for editor completion); unreadable
    tables are left out."""
    out: dict[str, list[dict[str, str]]] = {}
    for t in ws.tables:
        try:
            out[t.name] = [{"name": n, "type": ty} for n, ty in ws.table(t.name).schema.items()]
        except Exception:  # noqa: BLE001 - a broken table must not hide the others
            continue
    return out


def files(spec: TableSpec) -> list[tuple[str, int]]:
    """``(path_or_url, size)`` of the table's files (none if unreadable)."""
    try:
        return list_files(spec.path, spec.format)
    except Exception:  # noqa: BLE001 - shown as a table without files
        return []


def _typed(value: str | None, dtype: str) -> Any:
    """Numbers back as numbers; everything else as its display form."""
    if value is None:
        return None
    dtype = dtype.lower()
    try:
        if dtype.startswith(("int", "uint")):
            return int(value)
        if dtype.startswith(("float", "double")):
            return float(value)
    except ValueError:
        pass
    return value


def column_stats(ws: Workspace, spec: TableSpec, types: dict[str, str]) -> list[dict[str, Any]]:
    """Per top-level column: min, max and null count over all row groups."""
    if spec.format != "parquet":
        return []
    return [
        {
            "column": name,
            "min": _typed(lo, types.get(name, "")),
            "max": _typed(hi, types.get(name, "")),
            "nulls": nulls,
            "exact": exact,
        }
        for name, lo, hi, nulls, exact in ws.session.column_stats(spec.name)
    ]


def table_info(ws: Workspace, name: str) -> dict[str, Any]:
    spec = ws.spec(name)
    if spec is None:
        raise KeyError(f"table {name!r} is not in the catalog")
    types = dict(ws.table(spec.name).schema.items())
    listed = files(spec)
    info = spec_view(ws, spec)
    info["columns"] = [{"name": n, "type": t} for n, t in types.items()]
    info["num_rows"] = ws.sql(f"select count(*) from {spec.name}").collect().item()
    info["files"] = len(listed)
    info["bytes"] = sum(size for _, size in listed)
    info["stats"] = column_stats(ws, spec, types)
    return info
