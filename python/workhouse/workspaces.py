"""Workspaces: a directory with a ``workhouse.toml`` catalog of named tables.

.. code-block:: toml

    [workspace]
    name = "analytics"

    [tables.lineitem]
    path = "data/lineitem"     # relative to the workspace root: file, directory or glob
    format = "parquet"         # parquet | csv (default: from the extension, else parquet)

    [tables.trips]
    path = "raw/trips/*.csv"
    has_header = true
    separator = ","

    [tables.orders]
    path = "s3://my-bucket/tpch/orders/"   # object store URLs work too

    [storage."s3://my-bucket"]            # options for every URL under a prefix
    region = "us-east-1"

Credentials never go in ``workhouse.toml`` (it is meant to be committed):
they come from the environment or the machine's instance profile.

Notebooks and scripts get a session with every catalog table registered
(lazily: a table's files are listed on first use, and one that cannot be
read only fails the queries that use it):

    >>> ws = wh.workspace()    # finds workhouse.toml from the current directory upward
    >>> ws.sql("select count(*) from lineitem").collect()
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from workhouse.storage import is_remote, secret_keys

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover
    import tomli as tomllib

CONFIG_NAME = "workhouse.toml"
_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


@dataclass(frozen=True)
class TableSpec:
    """A catalog entry: a named Parquet or CSV dataset (local path or URL)."""

    name: str
    path: str
    format: str = "parquet"
    has_header: bool = True
    separator: str = ","

    @staticmethod
    def from_config(name: str, cfg: dict[str, Any], root: Path) -> TableSpec:
        if not _NAME_RE.match(name):
            raise ValueError(f"invalid table name {name!r} in {CONFIG_NAME}")
        if "path" not in cfg:
            raise ValueError(f"table {name!r} in {CONFIG_NAME} has no 'path'")
        path = resolve_path(str(cfg["path"]), root)
        fmt = cfg.get("format") or ("csv" if path.lower().endswith(".csv") else "parquet")
        if fmt not in ("parquet", "csv"):
            raise ValueError(f"table {name!r}: unsupported format {fmt!r}")
        return TableSpec(name, path, fmt, bool(cfg.get("has_header", True)), str(cfg.get("separator", ",")))

    @property
    def remote(self) -> bool:
        return is_remote(self.path)

    def register(self, ctx: Any) -> None:
        """Register (lazily) into a ``workhouse.SessionContext``."""
        if self.format == "csv":
            ctx.register_csv(self.name, self.path, self.has_header, self.separator, lazy=True)
        else:
            ctx.register_parquet(self.name, self.path, lazy=True)


def resolve_path(path: str, root: Path) -> str:
    """URLs as they are; local paths absolute (relative ones from ``root``)."""
    if is_remote(path):
        return path
    p = Path(path)
    return str(p if p.is_absolute() else root / p)


@dataclass
class Workspace:
    """A workspace root and its table catalog."""

    root: Path
    name: str
    tables: list[TableSpec] = field(default_factory=list)
    # default storage options by URL prefix ([storage."s3://bucket"])
    storage: dict[str, dict[str, Any]] = field(default_factory=dict)
    _session: Any = field(default=None, repr=False, compare=False)

    @property
    def config_path(self) -> Path:
        return self.root / CONFIG_NAME

    @property
    def session(self) -> Any:
        """A ``SessionContext`` with every catalog table registered (built once)."""
        if self._session is None:
            from workhouse import SessionContext, set_storage_options

            for prefix, options in self.storage.items():
                set_storage_options(prefix, options)
            ctx = SessionContext()
            for t in self.tables:
                t.register(ctx)
            self._session = ctx
        return self._session

    def sql(self, query: str, **tables: Any) -> Any:
        """Run SQL over the catalog plus extra tables given as keyword arguments
        (DataFrames, LazyFrames, pyarrow / pandas / polars tables; other values
        are ignored, so notebooks can pass every name a query mentions)."""
        extra = {n: as_table(v) for n, v in tables.items() if is_table_like(v)}
        ctx = self.session.fork() if extra else self.session
        for name, obj in extra.items():
            ctx.register(name, obj)
        return ctx.sql(query)

    def table(self, name: str) -> Any:
        return self.session.table(name)

    def spec(self, name: str) -> TableSpec | None:
        return next((t for t in self.tables if t.name == name.lower() or t.name == name), None)


def _is_pandas(obj: Any) -> bool:
    return type(obj).__module__.split(".")[0] == "pandas" and type(obj).__name__ == "DataFrame"


def is_table_like(obj: Any) -> bool:
    """Workhouse frames, and anything exporting an Arrow stream (pyarrow, polars) or pandas."""
    from workhouse import DataFrame, LazyFrame

    if isinstance(obj, (DataFrame, LazyFrame)):
        return True
    return (hasattr(obj, "__arrow_c_stream__") and not isinstance(obj, type)) or _is_pandas(obj)


def as_table(obj: Any) -> Any:
    if _is_pandas(obj) and not hasattr(obj, "__arrow_c_stream__"):
        import pyarrow as pa

        return pa.Table.from_pandas(obj, preserve_index=False)
    return obj


def find_root(start: str | os.PathLike[str] | None = None) -> Path | None:
    """The nearest directory at or above ``start`` holding a ``workhouse.toml``."""
    here = Path(start or os.getcwd()).resolve()
    if here.is_file():
        here = here.parent
    for d in (here, *here.parents):
        if (d / CONFIG_NAME).is_file():
            return d
    return None


def _candidates(path: str | os.PathLike[str] | None) -> list[Path | None]:
    if path is not None:
        return [Path(path)]
    env = os.environ.get("WORKHOUSE_WORKSPACE")
    main = getattr(sys.modules.get("__main__"), "__file__", None)
    return [Path(env) if env else None, Path(os.getcwd()), Path(main) if main else None]


def _storage_sections(cfg: dict[str, Any]) -> dict[str, dict[str, Any]]:
    sections = cfg.get("storage") or {}
    for prefix, options in sections.items():
        if not is_remote(prefix) or not isinstance(options, dict):
            raise ValueError(f"[storage.{prefix!r}] in {CONFIG_NAME}: expected a URL prefix with options")
        secrets = secret_keys(options)
        if secrets:
            raise ValueError(
                f"[storage.{prefix!r}] in {CONFIG_NAME} holds credentials ({', '.join(secrets)}): "
                "use environment variables or an instance profile instead"
            )
    return {p.rstrip("/"): dict(o) for p, o in sections.items()}


def parse_config(text: str, root: Path) -> Workspace:
    """A workspace from the text of its ``workhouse.toml``."""
    cfg = tomllib.loads(text)
    name = str(cfg.get("workspace", {}).get("name") or root.name)
    tables = [TableSpec.from_config(n, c, root) for n, c in (cfg.get("tables") or {}).items()]
    return Workspace(root, name, tables, _storage_sections(cfg))


_active: Workspace | None = None


def set_active(ws: Workspace | None) -> None:
    """The workspace ``load()`` returns when given no path (a kernel's, whose
    catalog may come from the Studio rather than a local file)."""
    global _active
    _active = ws


def load(path: str | os.PathLike[str] | None = None) -> Workspace:
    """Load the workspace at ``path`` (or found from ``$WORKHOUSE_WORKSPACE``,
    the current directory, then the running script's directory). Without a
    ``workhouse.toml`` the result is an empty workspace at that directory.
    Inside a kernel, ``load()`` is the kernel's workspace."""
    if path is None and _active is not None:
        return _active
    starts = [c for c in _candidates(path) if c is not None]
    root = next((r for r in map(find_root, starts) if r is not None), None)
    if root is None:
        base = starts[0].resolve() if starts else Path.cwd()
        return Workspace(base.parent if base.is_file() else base, (base.parent if base.is_file() else base).name)
    return parse_config((root / CONFIG_NAME).read_text(encoding="utf-8"), root)


def _toml_str(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def table_entry(name: str, path: str, format: str | None = None) -> str:
    """The ``[tables.<name>]`` section for a table."""
    lines = [f"\n[tables.{name}]", f"path = {_toml_str(path)}"]
    if format:
        lines.append(f"format = {_toml_str(format)}")
    return "\n".join(lines) + "\n"


def add_table(ws: Workspace, name: str, path: str, format: str | None = None, persist: bool = True) -> tuple[TableSpec, str]:
    """Add a table to the catalog; ``(spec, toml entry)``. With ``persist``
    the entry is appended to ``workhouse.toml`` (created if missing)."""
    if ws.spec(name) is not None:
        raise ValueError(f"table {name!r} already exists")
    if is_remote(path):
        rel = path
    else:
        rel = Path(os.path.relpath(path, ws.root) if Path(path).is_absolute() else path).as_posix()
    spec = TableSpec.from_config(name, {"path": rel, "format": format}, ws.root)
    entry = table_entry(name, rel, format)
    if persist:
        exists = ws.config_path.is_file()
        with open(ws.config_path, "a", encoding="utf-8") as f:
            if not exists:
                f.write(f"[workspace]\nname = {_toml_str(ws.name)}\n")
            f.write(entry)
    ws.tables.append(spec)
    ws._session = None
    return spec, entry
