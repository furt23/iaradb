"""Catalog browsing: table listings, schemas, sizes and Parquet statistics.

Files are listed and statistics read by the engine, so local paths and
object store URLs (``s3://...``) are browsed the same way.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from iara.storage import delta_history, delta_info, list_files
from iara.workspaces import TableSpec, Workspace, split_name


def _relative(ws: Workspace, spec: TableSpec) -> str:
    if spec.remote:
        return spec.path
    path = Path(spec.path)
    try:
        return path.relative_to(ws.root).as_posix()
    except ValueError:
        return path.as_posix()


def spec_view(ws: Workspace, spec: TableSpec) -> dict[str, Any]:
    """A table as the Studio lists it: ``catalog`` is left out for the default catalog."""
    full = ".".join(split_name(spec.name, ws.default_catalog)).lower()  # what a read grant names
    view = {"name": spec.name, "path": _relative(ws, spec), "format": spec.format, "full": full}
    if spec.catalog is not None:
        view["catalog"] = spec.catalog
    return view


def list_tables(ws: Workspace) -> list[dict[str, Any]]:
    return [spec_view(ws, t) for t in ws.tables + ws.discovered]


def schemas(ws: Workspace) -> dict[str, list[dict[str, str]]]:
    """Columns of every catalog table of every catalog, by its listed name (for
    editor completion); unreadable tables are left out."""
    out: dict[str, list[dict[str, str]]] = {}
    for t in ws.tables + ws.discovered:
        try:
            out[t.name] = [{"name": n, "type": ty} for n, ty in ws.table(t.name).schema.items()]
        except Exception:  # noqa: BLE001 - a broken table must not hide the others
            continue
    return out


def files(spec: TableSpec) -> list[tuple[str, int]]:
    """``(path_or_url, size)`` of the table's files (none if unreadable)."""
    try:
        if spec.format == "delta":
            return list_files(spec.path, "parquet")
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
    # the full name reaches the table whatever catalog and schema the session is in
    full = ".".join(split_name(spec.name, ws.default_catalog))
    # parquet footers and the Delta log hold the count; another format would be read whole (the Studio answers this without a cluster)
    info["num_rows"] = ws.sql(f"select count(*) from {full}").collect().item() if spec.format in ("parquet", "delta") else None
    info["files"] = len(listed)
    info["bytes"] = sum(size for _, size in listed)
    if spec.format == "delta":
        # the log says which files are current (the folder also holds the removed ones)
        try:
            d = delta_info(spec.path)
            info.update(
                files=d["num_files"],
                bytes=d["size_bytes"],
                version=d["version"],
                partitions=d["partition_columns"],
                description=d["description"],
            )
            not_null = set(d.get("not_null_columns", []))
            for c in info["columns"]:
                c["nullable"] = c["name"] not in not_null
        except Exception:  # noqa: BLE001 - shown as a table without log details
            info.update(version=None, partitions=[])
    info["stats"] = column_stats(ws, spec, types)
    return info


def history(ws: Workspace, name: str, limit: int = 50) -> list[dict[str, Any]]:
    """The commits of a Delta table, newest first (``limit`` of them)."""
    spec = ws.spec(name)
    if spec is None:
        raise KeyError(f"table {name!r} is not in the catalog")
    if spec.format != "delta":
        raise ValueError(f"table {name!r} is not a Delta table: it has no history")
    return delta_history(spec.path, limit=max(1, limit))
