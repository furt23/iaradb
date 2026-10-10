"""Workspaces: a directory with a ``workhouse.toml`` catalog of named tables.

.. code-block:: toml

    [workspace]
    name = "analytics"

    [tables.lineitem]
    path = "data/lineitem"     # relative to the workspace root: file, directory or glob
    format = "parquet"         # parquet | csv | json (NDJSON or a JSON array; default: from the extension, else parquet)

    [tables.trips]
    path = "raw/trips/*.csv"
    has_header = true
    separator = ","

    [tables.orders]
    path = "s3://my-bucket/tpch/orders/"   # object store URLs work too

    [tables.tpch.region]                   # a table in the schema tpch
    path = "data/tpch/region.parquet"

    [schemas.sales]                        # a schema, declared before it has tables
    description = "Sales figures"

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
from collections.abc import Callable
from pathlib import Path
from typing import Any

from workhouse.sqlwrite import WriteResult, is_schema_statement, is_write
from workhouse.storage import is_remote, secret_keys

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover
    import tomli as tomllib

CONFIG_NAME = "workhouse.toml"
#: the schema every workspace has; its tables are named without a prefix
MAIN = "main"
_PART_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def check_schema(name: str) -> str:
    """A schema name in lowercase; ValueError unless it is one identifier."""
    if not _PART_RE.fullmatch(name):
        raise ValueError(f"invalid schema name {name!r} in {CONFIG_NAME}")
    return name.lower()


def split_name(name: str) -> tuple[str, str]:
    """``(schema, table)`` of a table name (``orders`` is ``main.orders``);
    ValueError unless each part is one identifier."""
    parts = name.split(".")
    if len(parts) == 1:
        parts.insert(0, MAIN)
    if len(parts) != 2 or not all(_PART_RE.fullmatch(p) for p in parts):
        raise ValueError(f"invalid table name {name!r} in {CONFIG_NAME}")
    return parts[0].lower(), parts[1].lower()


def display_name(name: str) -> str:
    """The name a table is listed under: bare in ``main``, ``schema.table`` elsewhere."""
    schema, table = split_name(name)
    return table if schema == MAIN else f"{schema}.{table}"


def schema_of(name: str) -> str:
    return split_name(name)[0]


def _key(name: str) -> str:
    """Identity of a table name: case-insensitive, and ``main.x`` is ``x``."""
    return name.lower().removeprefix(f"{MAIN}.")


@dataclass(frozen=True)
class TableSpec:
    """A catalog entry: a named Parquet, CSV or JSON (NDJSON) dataset (local path or URL).

    ``name`` is the display name: ``orders``, or ``tpch.lineitem`` in a schema."""

    name: str
    path: str
    format: str = "parquet"
    has_header: bool = True
    separator: str = ","

    @staticmethod
    def from_config(name: str, cfg: dict[str, Any], root: Path) -> TableSpec:
        name = display_name(name)
        if "path" not in cfg:
            raise ValueError(f"table {name!r} in {CONFIG_NAME} has no 'path'")
        path = resolve_path(str(cfg["path"]), root)
        fmt = cfg.get("format") or _format_of(path)
        if fmt not in ("parquet", "csv", "json"):
            raise ValueError(f"table {name!r}: unsupported format {fmt!r}")
        return TableSpec(name, path, fmt, bool(cfg.get("has_header", True)), str(cfg.get("separator", ",")))

    @property
    def remote(self) -> bool:
        return is_remote(self.path)

    def register(self, ctx: Any) -> None:
        """Register (lazily) into a ``workhouse.SessionContext``."""
        if self.format == "csv":
            ctx.register_csv(self.name, self.path, self.has_header, self.separator, lazy=True)
        elif self.format == "json":
            ctx.register_json(self.name, self.path, lazy=True)
        else:
            ctx.register_parquet(self.name, self.path, lazy=True)


def _format_of(path: str) -> str:
    """The format a path's extension says: CSV, JSON / NDJSON or Parquet."""
    p = path.lower()
    if p.endswith(".csv"):
        return "csv"
    return "json" if p.endswith((".json", ".ndjson", ".jsonl")) else "parquet"


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
    #: where ``CREATE TABLE ... AS`` writes tables: a folder (relative to the
    #: root) or an ``s3://`` prefix; ``warehouse/`` in the root by default
    warehouse: str | None = None
    #: schemas declared in the catalog, besides ``main``: name -> description ("" if none)
    declared_schemas: dict[str, str] = field(default_factory=dict)
    #: told of every catalog change a statement made: ``{name, entry, kind}`` with
    #: the new ``workhouse.toml`` section (None: removed); kind is "table" or "schema"
    on_catalog_change: Callable[[dict[str, Any]], None] | None = field(default=None, repr=False, compare=False)
    _session: Any = field(default=None, repr=False, compare=False)

    @property
    def config_path(self) -> Path:
        return self.root / CONFIG_NAME

    @property
    def schemas(self) -> list[str]:
        """Every schema, ``main`` first: the declared ones and those tables use."""
        names = set(self.declared_schemas) | {schema_of(t.name) for t in self.tables}
        return [MAIN, *sorted(names - {MAIN})]

    @property
    def session(self) -> Any:
        """A ``SessionContext`` with every catalog table registered (built once)."""
        if self._session is None:
            from workhouse import SessionContext, set_storage_options

            for prefix, options in self.storage.items():
                set_storage_options(prefix, options)
            ctx = SessionContext()
            ctx.set_warehouse(self.warehouse_path)
            for schema in self.declared_schemas:
                ctx.sql(f"create schema if not exists {schema}").collect()
            for t in self.tables:
                t.register(ctx)
            self._session = ctx
        return self._session

    @property
    def warehouse_path(self) -> str:
        """Where created tables go: a local folder (absolute) or a URL."""
        return resolve_path(self.warehouse or "warehouse", self.root)

    def sql(self, query: str, **tables: Any) -> Any:
        """Run SQL over the catalog plus extra tables given as keyword arguments
        (DataFrames, LazyFrames, pyarrow / pandas / polars tables; other values
        are ignored, so notebooks can pass every name a query mentions)."""
        extra = {n: as_table(v) for n, v in tables.items() if is_table_like(v)}
        if is_write(query):
            return self._write(query, extra)
        return self._scratch(extra).sql(query)

    def _scratch(self, extra: dict[str, Any]) -> Any:
        """The session, or a fork of it holding the given frames."""
        if not extra:
            return self.session
        ctx = self.session.fork()
        for name, obj in extra.items():
            ctx.register(name, obj)
        return ctx

    def _write(self, query: str, extra: dict[str, Any]) -> Any:
        """Run a statement that writes or changes schemas; the tables and schemas
        it creates or drops join or leave the catalog (and the main session, when
        it ran on a fork)."""
        ctx = self.session if is_schema_statement(query) else self._scratch(extra)
        frame = ctx.sql(query).collect()
        self._apply(WriteResult.of(frame), forked=ctx is not self.session)
        return frame.lazy()

    def _apply(self, done: WriteResult, forked: bool) -> None:
        if done.operation in ("create", "insert") and done.table and done.path:
            if forked:
                self.session.register_parquet(done.table, done.path)
            if done.operation == "create":
                self._catalog_set(done.table, done.path)
        elif done.operation == "drop" and done.table:
            if forked:
                self.session.deregister(done.table)
            self._catalog_drop(done.table)
        elif done.operation == "create schema" and done.table:
            self._schema_set(done.table)
        elif done.operation == "drop schema" and done.table:
            self._schema_drop(done.table)

    def _relative(self, path: str) -> str:
        if is_remote(path):
            return path
        try:
            return Path(os.path.relpath(path, self.root)).as_posix()
        except ValueError:  # another drive
            return Path(path).as_posix()

    def _catalog_set(self, name: str, path: str) -> None:
        name, rel = display_name(name), self._relative(path)
        self.tables = [t for t in self.tables if t.name != name]
        self.tables.append(TableSpec.from_config(name, {"path": rel}, self.root))
        self._emit(name, table_entry(name, rel))

    def _catalog_drop(self, name: str) -> None:
        name = display_name(name)
        before = len(self.tables)
        self.tables = [t for t in self.tables if t.name != name]
        if len(self.tables) != before:
            self._emit(name, None)

    def _schema_set(self, name: str) -> None:
        """A schema created by a statement: declared unless it is main or already declared."""
        schema = check_schema(name)
        if schema == MAIN or schema in self.declared_schemas:
            return
        self.declared_schemas[schema] = ""
        self._emit(schema, schema_entry(schema), "schema")

    def _schema_drop(self, name: str) -> None:
        """A schema dropped with its tables (CASCADE): a drop per table, then the schema."""
        schema = check_schema(name)
        if schema == MAIN:
            return
        members = [t.name for t in self.tables if schema_of(t.name) == schema]
        for table in members:
            self._catalog_drop(table)
        declared = self.declared_schemas.pop(schema, None) is not None
        if declared or members:
            self._emit(schema, None, "schema")

    def _emit(self, name: str, entry: str | None, kind: str = "table") -> None:
        if self.on_catalog_change:
            self.on_catalog_change({"name": name, "entry": entry, "kind": kind})

    def table(self, name: str) -> Any:
        return self.session.table(name)

    def spec(self, name: str) -> TableSpec | None:
        key = _key(name)
        return next((t for t in self.tables if _key(t.name) == key), None)


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


def _split_tables(tables: dict[str, Any]) -> tuple[list[tuple[str, dict[str, Any]]], list[str]]:
    """The ``(name, section)`` of every table in ``[tables]``, and the empty
    sections among them (schemas declared by name alone). ``[tables.x]`` is table
    ``x`` of main; ``[tables.s.x]`` (or ``[tables."s.x"]``) is table ``x`` of ``s``,
    and a section without ``path`` holds the tables of a schema."""
    found: list[tuple[str, dict[str, Any]]] = []
    declared: list[str] = []
    for key, section in tables.items():
        if not isinstance(section, dict):
            raise ValueError(f"tables.{key} in {CONFIG_NAME}: expected a section")
        if "path" in section:
            if any(isinstance(v, dict) for v in section.values()):
                raise ValueError(f"tables.{key} is both a table and a schema in {CONFIG_NAME}")
            found.append((key, section))
        elif all(isinstance(v, dict) for v in section.values()):
            if not section:
                declared.append(check_schema(key))
            found.extend((f"{key}.{sub}", cfg) for sub, cfg in section.items())
        else:
            raise ValueError(f"table {key!r} in {CONFIG_NAME} has no 'path'")
    return found, declared


def _declared(empty: list[str], sections: dict[str, Any]) -> dict[str, str]:
    """Schemas by name -> description: from ``[schemas.<s>]`` and from empty table sections."""
    declared = {name: "" for name in empty}
    for name, section in sections.items():
        if not isinstance(section, dict):
            raise ValueError(f"schemas.{name} in {CONFIG_NAME}: expected a section")
        declared[check_schema(name)] = str(section.get("description", ""))
    declared.pop(MAIN, None)
    return declared


def _check_unique(tables: list[TableSpec]) -> None:
    seen: set[str] = set()
    for t in tables:
        if t.name in seen:
            raise ValueError(f"table {t.name!r} is defined twice in {CONFIG_NAME}")
        seen.add(t.name)


def parse_config(text: str, root: Path) -> Workspace:
    """A workspace from the text of its ``workhouse.toml``."""
    cfg = tomllib.loads(text)
    section = cfg.get("workspace", {})
    name = str(section.get("name") or root.name)
    found, empty = _split_tables(cfg.get("tables") or {})
    tables = [TableSpec.from_config(n, c, root) for n, c in found]
    _check_unique(tables)
    warehouse = section.get("warehouse")
    declared = _declared(empty, cfg.get("schemas") or {})
    return Workspace(
        root,
        name,
        tables,
        _storage_sections(cfg),
        str(warehouse) if warehouse else None,
        declared_schemas=declared,
    )


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
    """The ``[tables.<name>]`` section of a table (``[tables.tpch.lineitem]`` in a schema)."""
    lines = [f"\n[tables.{display_name(name)}]", f"path = {_toml_str(path)}"]
    if format:
        lines.append(f"format = {_toml_str(format)}")
    return "\n".join(lines) + "\n"


def schema_entry(name: str) -> str:
    """The ``[schemas.<name>]`` section declaring a schema."""
    return f"\n[schemas.{check_schema(name)}]\n"


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
    entry = table_entry(spec.name, rel, format)
    if persist:
        exists = ws.config_path.is_file()
        with open(ws.config_path, "a", encoding="utf-8") as f:
            if not exists:
                f.write(f"[workspace]\nname = {_toml_str(ws.name)}\n")
            f.write(entry)
    ws.tables.append(spec)
    ws._session = None
    return spec, entry
