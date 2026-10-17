"""Workspaces: a directory with a ``iara.toml`` catalog of named tables.

.. code-block:: toml

    [workspace]
    name = "analytics"

    [tables.lineitem]
    path = "data/lineitem"     # relative to the workspace root: file, directory or glob
    format = "parquet"         # parquet | delta | csv | json (NDJSON or a JSON array; default: from the extension, else parquet;
                               # a Parquet folder that holds a Delta log is read as Delta; tables created by CREATE TABLE are delta)

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

    [schemas.tpch_sf10]                    # every data folder under the location is a table of the schema
    location = "s3://my-bucket/tpch/sf10/"

    [storage."s3://my-bucket"]            # options for every URL under a prefix
    region = "us-east-1"

    [catalogs.archive]                     # another catalog: tables are archive.<schema>.<table>
    description = "Closed years"

    [catalogs.archive.schemas.raw]         # a schema of the catalog (description, location)
    [catalogs.archive.tables.orders]       # a table in archive.main
    path = "archive/orders"
    [catalogs.archive.tables.raw.events]   # a table in archive.raw
    path = "archive/events"

A schema with a ``location`` has a table for each of its first-level folders
holding data files (named after the folder; explicit ``[tables]`` win), and
``CREATE TABLE`` in it writes a new folder there. These tables are not written to ``iara.toml``.

The workspace's own tables, schemas and ``[tables]`` / ``[schemas]`` sections belong to
its *default catalog*, named after ``[workspace] name`` (lowercase, other characters
as ``_``; the folder's name without one). Names are ``table`` and ``schema.table`` in
it, and ``catalog.schema.table`` in any other catalog.

Credentials never go in ``iara.toml`` (it is meant to be committed):
they come from the environment or the machine's instance profile.

Notebooks and scripts get a session with every catalog table registered
(lazily: a table's files are listed on first use, and one that cannot be
read only fails the queries that use it):

    >>> ws = ia.workspace()    # finds iara.toml from the current directory upward
    >>> ws.sql("select count(*) from lineitem").collect()
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass, field
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from iara.sqlwrite import WriteResult, is_schema_statement, is_write
from iara.storage import is_remote, list_files, secret_keys

if TYPE_CHECKING:  # the return types notebooks' completions follow
    from iara import LazyFrame, SessionContext

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover
    import tomli as tomllib

CONFIG_NAME = "iara.toml"
#: the schema every workspace has; its tables are named without a prefix
MAIN = "main"
_PART_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def check_schema(name: str) -> str:
    """A schema name in lowercase; ValueError unless it is one identifier."""
    if not _PART_RE.fullmatch(name):
        raise ValueError(f"invalid schema name {name!r} in {CONFIG_NAME}")
    return name.lower()


def check_catalog(name: str) -> str:
    """A catalog name in lowercase; ValueError unless it is one identifier."""
    if not _PART_RE.fullmatch(name):
        raise ValueError(f"invalid catalog name {name!r} in {CONFIG_NAME}")
    return name.lower()


def normalize_catalog_name(name: str) -> str:
    """The default catalog's name for a workspace name: lowercase, every character
    outside ``[a-z0-9_]`` as ``_`` (two for one outside the BMP, as the Studio counts
    them), ``_`` before a leading digit, ``main`` when empty."""
    ident = re.sub(r"[^a-z0-9_]", lambda m: "_" * (2 if ord(m.group()) > 0xFFFF else 1), name.lower())
    if not ident:
        return MAIN
    return f"_{ident}" if ident[0].isdigit() else ident


def split_name(name: str, default: str) -> tuple[str, str, str]:
    """``(catalog, schema, table)`` of a table name relative to the ``default`` catalog:
    ``orders`` is ``default.main.orders`` and ``s.orders`` is ``default.s.orders``.
    ValueError unless it has one to three parts, each one identifier."""
    parts = name.split(".")
    if not 1 <= len(parts) <= 3 or not all(_PART_RE.fullmatch(p) for p in parts):
        raise ValueError(f"invalid table name {name!r} in {CONFIG_NAME}")
    catalog, schema, table = [default, MAIN][: 3 - len(parts)] + parts
    return catalog.lower(), schema.lower(), table.lower()


def display_name(name: str, default: str) -> str:
    """The name a table is listed under. In the ``default`` catalog: bare in ``main``,
    ``schema.table`` elsewhere. In any other catalog: ``catalog.schema.table``."""
    catalog, schema, table = split_name(name, default)
    if catalog != default:
        return f"{catalog}.{schema}.{table}"
    return table if schema == MAIN else f"{schema}.{table}"


def schema_of(table: str) -> str:
    """The schema a table (as listed) is in, as schemas are listed: ``main`` for
    ``orders``, ``tpch`` for ``tpch.lineitem``, ``sales.raw`` for ``sales.raw.events``."""
    return table.rpartition(".")[0] or MAIN


def catalog_of_schema(schema: str) -> str | None:
    """The catalog a schema (as listed: ``tpch`` or ``sales.raw``) is in; None for the default catalog."""
    return schema.partition(".")[0] if "." in schema else None


@dataclass(frozen=True)
class TableSpec:
    """A catalog entry: a named Parquet, CSV or JSON (NDJSON) dataset (local path or URL).

    ``name`` is the display name: ``orders``, ``tpch.lineitem`` in a schema, or
    ``sales.raw.events`` in another catalog."""

    name: str
    path: str
    format: str = "parquet"
    has_header: bool = True
    separator: str = ","

    @property
    def catalog(self) -> str | None:
        """The catalog it is in; None for the default catalog."""
        parts = self.name.split(".")
        return parts[0] if len(parts) == 3 else None

    @staticmethod
    def from_config(name: str, cfg: dict[str, Any], root: Path, default: str) -> TableSpec:
        name = display_name(name, default)
        if "path" not in cfg:
            raise ValueError(f"table {name!r} in {CONFIG_NAME} has no 'path'")
        path = resolve_path(str(cfg["path"]), root)
        fmt = cfg.get("format") or _format_of(path)
        if fmt not in ("parquet", "delta", "csv", "json"):
            raise ValueError(f"table {name!r}: unsupported format {fmt!r}")
        return TableSpec(name, path, fmt, bool(cfg.get("has_header", True)), str(cfg.get("separator", ",")))

    @property
    def remote(self) -> bool:
        return is_remote(self.path)

    def register(self, ctx: Any) -> None:
        """Register (lazily) into a ``iara.SessionContext``."""
        if self.format == "csv":
            ctx.register_csv(self.name, self.path, self.has_header, self.separator, lazy=True)
        elif self.format == "json":
            ctx.register_json(self.name, self.path, lazy=True)
        elif self.format == "delta":
            ctx.register_delta(self.name, self.path, lazy=True)
        else:
            # a folder is Parquet files or a Delta table: told apart once, when the table loads
            ctx.register_table(self.name, self.path, lazy=True)


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
    """A workspace root and its table catalogs: the default one and the others."""

    root: Path
    name: str
    tables: list[TableSpec] = field(default_factory=list)
    # default storage options by URL prefix ([storage."s3://bucket"])
    storage: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: where ``CREATE TABLE ... AS`` writes tables: a folder (relative to the
    #: root) or an ``s3://`` prefix; ``warehouse/`` in the root by default
    warehouse: str | None = None
    #: schemas declared in the catalogs, besides ``main``, as they are listed
    #: (``s``, or ``c.s`` in another catalog): name -> description ("" if none)
    declared_schemas: dict[str, str] = field(default_factory=dict)
    #: schemas with a ``location`` (``s`` or ``c.s``): name -> folder or URL (resolved)
    schema_locations: dict[str, str] = field(default_factory=dict)
    #: tables found under the schema locations (not in ``tables``, never in ``iara.toml``)
    discovered: list[TableSpec] = field(default_factory=list)
    #: the catalogs besides the default one: name -> description ("" if none)
    catalogs: dict[str, str] = field(default_factory=dict)
    #: told of every catalog change a statement made: ``{name, entry, kind}`` with
    #: the new ``iara.toml`` section (None: removed); kind is "table", "schema" or "catalog"
    on_catalog_change: Callable[[dict[str, Any]], None] | None = field(default=None, repr=False, compare=False)
    _session: Any = field(default=None, repr=False, compare=False)

    @property
    def config_path(self) -> Path:
        return self.root / CONFIG_NAME

    @property
    def default_catalog(self) -> str:
        """The catalog of ``[tables]`` and ``[schemas]``: the workspace's name, as an identifier."""
        return normalize_catalog_name(self.name)

    @property
    def catalog_names(self) -> list[str]:
        """Every catalog, the default one first and the others sorted."""
        return [self.default_catalog, *sorted(self.catalogs)]

    @property
    def schemas(self) -> list[str]:
        """Every schema of the default catalog, ``main`` first: the declared ones and those tables use."""
        return self.schemas_of()

    def schemas_of(self, catalog: str | None = None) -> list[str]:
        """The schemas of a catalog (None or the default one: the default catalog),
        ``main`` first: the declared ones and those its tables use."""
        catalog = None if catalog == self.default_catalog else catalog
        listed = set(self.declared_schemas) | {schema_of(t.name) for t in self.tables + self.discovered}
        names = {s.rpartition(".")[2] for s in listed if catalog_of_schema(s) == catalog}
        return [MAIN, *sorted(names - {MAIN})]

    @property
    def session(self) -> SessionContext:
        """A ``SessionContext`` with every catalog table registered (built once)."""
        if self._session is None:
            from iara import SessionContext, set_storage_options

            for prefix, options in self.storage.items():
                set_storage_options(prefix, options)
            ctx = SessionContext(self.default_catalog)
            ctx.set_warehouse(self.warehouse_path)
            for catalog in self.catalogs:
                ctx.sql(f"create catalog if not exists {catalog}").collect()
            for schema in self.declared_schemas:
                ctx.sql(f"create schema if not exists {schema}").collect()
            for t in self.tables:
                t.register(ctx)
            for schema, location in self.schema_locations.items():
                ctx.set_schema_location(schema, location)
            self._session = ctx
            self.refresh()
        return self._session

    def _scan(self) -> None:
        """Register the folders under each schema location as tables, except those
        an explicit table names; ``discovered`` becomes what was found."""
        explicit = {t.name for t in self.tables}
        found: list[TableSpec] = []
        for schema, location in self.schema_locations.items():
            for table, path, fmt in discover_tables(location):
                name = display_name(f"{schema}.{table}", self.default_catalog)
                if name not in explicit:
                    found.append(TableSpec(name, path, fmt))
        ctx = self._session
        keep = {t.name for t in found}
        for old in self.discovered:
            if old.name not in keep:
                ctx.deregister(old.name)
        known = {t.name: t for t in self.discovered}
        for t in found:
            if known.get(t.name) != t:
                t.register(ctx)
        self.discovered = found

    def refresh(self) -> bool:
        """Re-scan the schema locations: new folders become tables and vanished
        ones leave. True if the discovered tables changed."""
        if self._session is None or not self.schema_locations:
            return False
        before = list(self.discovered)
        try:
            self._scan()
        except Exception:  # noqa: BLE001 - an unreadable location must not stop a run
            return False
        return before != self.discovered

    @property
    def warehouse_path(self) -> str:
        """Where created tables go: a local folder (absolute) or a URL."""
        return resolve_path(self.warehouse or "warehouse", self.root)

    def sql(self, query: str, params: Any = None, **tables: Any) -> LazyFrame:
        """Run SQL over the catalog plus extra tables given as keyword arguments
        (DataFrames, LazyFrames, pyarrow / pandas / polars tables; other values
        are ignored, so notebooks can pass every name a query mentions).
        ``params`` (reserved, so not a table name) binds the placeholders: a
        list or tuple for ``$1``, ``$2`` / ``?``, a dict for ``:name`` / ``$name``."""
        extra = {n: as_table(v) for n, v in tables.items() if is_table_like(v)}
        if is_write(query):
            return self._write(query, extra, params)
        return self._scratch(extra).sql(query, params)

    def _scratch(self, extra: dict[str, Any]) -> Any:
        """The session, or a fork of it holding the given frames. Bare names are
        looked up in the current catalog, so the frames go to its ``main``."""
        if not extra:
            return self.session
        ctx = self.session.fork()
        home = ctx.current_catalog()
        prefix = "" if home == self.default_catalog else f"{home}.{MAIN}."
        for name, obj in extra.items():
            ctx.register(prefix + name, obj)
        return ctx

    def _write(self, query: str, extra: dict[str, Any], params: Any = None) -> LazyFrame:
        """Run a statement that writes or changes schemas and catalogs; the tables,
        schemas and catalogs it creates or drops join or leave the catalog (and the
        main session, when it ran on a fork)."""
        self._refuse_drop(query)
        ctx = self.session if is_schema_statement(query) else self._scratch(extra)
        frame = ctx.sql(query, params).collect()
        self._apply(WriteResult.of(frame), forked=ctx is not self.session)
        return frame.lazy()

    def _refuse_drop(self, query: str) -> None:
        """A discovered table is a folder: dropping it (or its schema or catalog) is refused."""
        target = drop_target(query)
        if target is None:
            return
        kind, name = target
        listed = self._listed(kind, name)
        if listed is None:  # not a valid name: the engine says so
            return
        if kind == "table":
            spec = next((t for t in self.discovered if t.name == listed), None)
            if spec is not None:
                raise ValueError(
                    f"{spec.name} is the folder {spec.path} under schema {schema_of(spec.name)}'s location: "
                    "delete the folder to remove the table"
                )
        elif kind == "schema":
            if listed in self.schema_locations and any(schema_of(t.name) == listed for t in self.discovered):
                raise ValueError(
                    f"schema {listed} has a location and its tables are folders under "
                    f"{self.schema_locations[listed]}: delete the folders to remove them"
                )
        else:
            located = {s for s in self.schema_locations if catalog_of_schema(s) == listed}
            if any(schema_of(t.name) in located for t in self.discovered):
                raise ValueError(
                    f"catalog {listed} has schemas with a location and their tables are folders: "
                    "delete the folders to remove them"
                )

    def _listed(self, kind: str, name: str) -> str | None:
        """The name a ``DROP`` target has as it is listed (None if it is not a valid
        name); what the name leaves out is the session's current catalog and schema."""
        parts = name.lower().split(".")
        if kind == "catalog":
            return parts[0] if len(parts) == 1 else None
        ctx = self.session
        width = 3 if kind == "table" else 2
        full = ".".join([ctx.current_catalog(), ctx.current_schema()][: max(0, width - len(parts))] + parts)
        try:
            return display_name(full, self.default_catalog) if kind == "table" else self._schema_name(full)
        except ValueError:
            return None

    def _schema_name(self, name: str) -> str:
        """A schema name as schemas are listed: lowercase, ``s`` in the default
        catalog and ``c.s`` in another; ValueError unless it is a schema name."""
        catalog, _, schema = name.rpartition(".")
        schema = check_schema(schema)
        if not catalog or check_catalog(catalog) == self.default_catalog:
            return schema
        return f"{catalog.lower()}.{schema}"

    def _register_main(self, table: str, path: str, fmt: str | None) -> None:
        """Register a table a statement made or changed on a fork in the main session."""
        if fmt == "delta":
            self.session.register_delta(table, path)
        else:
            self.session.register_parquet(table, path)

    def _apply(self, done: WriteResult, forked: bool) -> None:
        op = done.operation
        if op == "create" and done.table and schema_of(done.table) in self.schema_locations:
            self._created_in_location(done.table, done.path, forked, done.format)
        elif op in ("create", "insert", "insert overwrite", "truncate") and done.table and done.path:
            if forked:
                self._register_main(done.table, done.path, done.format)
            if op == "create":
                self._catalog_set(done.table, done.path, done.format)
        elif op in ("delete", "update", "merge", "optimize", "restore", "alter") and done.table and done.path:
            # a new Delta version (an ALTER may also change the columns): the main session must see it
            if forked:
                self._register_main(done.table, done.path, "delta")
            if op == "alter":
                self._emit(schema_of(done.table), None, "refresh")
        elif op == "drop" and done.table:
            if forked:
                self.session.deregister(done.table)
            self._catalog_drop(done.table)
        elif op == "create schema" and done.table:
            self._schema_set(done.table)
        elif op == "drop schema" and done.table:
            self._schema_drop(done.table)
        elif op == "create catalog" and done.table:
            self._new_catalog(done.table)
        elif op == "drop catalog" and done.table:
            self._drop_catalog(done.table)

    def _created_in_location(self, table: str, path: str | None, forked: bool, fmt: str | None = None) -> None:
        """A table made in a location schema is discovered, not declared."""
        if path:
            if forked:
                self._register_main(table, path, fmt)
            spec = TableSpec(table, path, "delta" if fmt == "delta" else "parquet")
            self.discovered = [t for t in self.discovered if t.name != table] + [spec]
        self._emit(schema_of(table), None, "refresh")

    def _relative(self, path: str) -> str:
        if is_remote(path):
            return path
        try:
            return Path(os.path.relpath(path, self.root)).as_posix()
        except ValueError:  # another drive
            return Path(path).as_posix()

    def _catalog_set(self, name: str, path: str, fmt: str | None = None) -> None:
        """A table a statement created: Delta ones are written with ``format = "delta"``."""
        name, rel = display_name(name, self.default_catalog), self._relative(path)
        fmt = "delta" if fmt == "delta" else None
        self.tables = [t for t in self.tables if t.name != name]
        self.tables.append(TableSpec.from_config(name, {"path": rel, "format": fmt}, self.root, self.default_catalog))
        self._emit(name, table_entry(name, rel, fmt))

    def _catalog_drop(self, name: str) -> None:
        name = display_name(name, self.default_catalog)
        before = len(self.tables)
        self.tables = [t for t in self.tables if t.name != name]
        if len(self.tables) != before:
            self._emit(name, None)

    def _schema_set(self, name: str) -> None:
        """A schema created by a statement: declared unless it is a main or already declared."""
        schema = self._schema_name(name)
        if schema.rpartition(".")[2] == MAIN or schema in self.declared_schemas:
            return
        self.declared_schemas[schema] = ""
        self._emit(schema, schema_entry(schema), "schema")

    def _schema_drop(self, name: str) -> None:
        """A schema dropped with its tables (CASCADE): a drop per table, then the schema."""
        schema = self._schema_name(name)
        if schema.rpartition(".")[2] == MAIN:
            return
        members = [t.name for t in self.tables if schema_of(t.name) == schema]
        for table in members:
            self._catalog_drop(table)
        declared = self.declared_schemas.pop(schema, None) is not None
        self.schema_locations.pop(schema, None)
        if declared or members:
            self._emit(schema, None, "schema")

    def _new_catalog(self, name: str) -> None:
        """A catalog created by a statement: declared unless it is the default one or already declared."""
        catalog = check_catalog(name)
        if catalog == self.default_catalog or catalog in self.catalogs:
            return
        self.catalogs[catalog] = ""
        self._emit(catalog, catalog_entry(catalog), "catalog")

    def _drop_catalog(self, name: str) -> None:
        """A catalog dropped with its contents (CASCADE): a drop per table, per
        declared schema, then the catalog."""
        catalog = check_catalog(name)
        if catalog == self.default_catalog:
            return
        members = [t.name for t in self.tables if t.catalog == catalog]
        for table in members:
            self._catalog_drop(table)
        for schema in [s for s in self.declared_schemas if catalog_of_schema(s) == catalog]:
            del self.declared_schemas[schema]
            self.schema_locations.pop(schema, None)
            self._emit(schema, None, "schema")
        self.discovered = [t for t in self.discovered if t.catalog != catalog]
        if self.catalogs.pop(catalog, None) is not None or members:
            self._emit(catalog, None, "catalog")

    def _emit(self, name: str, entry: str | None, kind: str = "table") -> None:
        if self.on_catalog_change:
            self.on_catalog_change({"name": name, "entry": entry, "kind": kind})

    def table(self, name: str) -> LazyFrame:
        return self.session.table(name)

    def spec(self, name: str) -> TableSpec | None:
        """The table a name refers to (``t``, ``s.t`` or ``c.s.t``, relative to the default catalog)."""
        try:
            listed = display_name(name, self.default_catalog)
        except ValueError:
            return None
        return next((t for t in self.tables + self.discovered if t.name == listed), None)


def _is_pandas(obj: Any) -> bool:
    return type(obj).__module__.split(".")[0] == "pandas" and type(obj).__name__ == "DataFrame"


def is_table_like(obj: Any) -> bool:
    """Iara frames, and anything exporting an Arrow stream (pyarrow, polars) or pandas."""
    from iara import DataFrame, LazyFrame

    if isinstance(obj, (DataFrame, LazyFrame)):
        return True
    return (hasattr(obj, "__arrow_c_stream__") and not isinstance(obj, type)) or _is_pandas(obj)


def as_table(obj: Any) -> Any:
    if _is_pandas(obj) and not hasattr(obj, "__arrow_c_stream__"):
        import pyarrow as pa

        return pa.Table.from_pandas(obj, preserve_index=False)
    return obj


def find_root(start: str | os.PathLike[str] | None = None) -> Path | None:
    """The nearest directory at or above ``start`` holding a ``iara.toml``."""
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
    env = os.environ.get("IARA_WORKSPACE")
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


def _split_tables(tables: dict[str, Any], where: str = "tables") -> tuple[list[tuple[str, dict[str, Any]]], list[str]]:
    """The ``(name, section)`` of every table in ``[tables]`` (``where`` names the
    section in errors), and the empty sections among them (schemas declared by name
    alone). ``[tables.x]`` is table ``x`` of main; ``[tables.s.x]`` (or
    ``[tables."s.x"]``) is table ``x`` of ``s``, and a section without ``path``
    holds the tables of a schema. A name has at most those two parts."""
    found: list[tuple[str, dict[str, Any]]] = []
    declared: list[str] = []
    for key, section in tables.items():
        if not isinstance(section, dict):
            raise ValueError(f"{where}.{key} in {CONFIG_NAME}: expected a section")
        if "path" in section:
            if any(isinstance(v, dict) for v in section.values()):
                raise ValueError(f"{where}.{key} is both a table and a schema in {CONFIG_NAME}")
            found.append((key, section))
        elif all(isinstance(v, dict) for v in section.values()):
            if not section:
                declared.append(check_schema(key))
            found.extend((f"{key}.{sub}", cfg) for sub, cfg in section.items())
        else:
            raise ValueError(f"table {key!r} in {CONFIG_NAME} has no 'path'")
    for name, _ in found:
        if name.count(".") > 1:
            raise ValueError(f"invalid table name {name!r} in {CONFIG_NAME}: expected table or schema.table")
    return found, declared


def _qualify(catalog: str | None, name: str) -> str:
    """``name`` inside a catalog (None: the default one, so as it is)."""
    return name if catalog is None else f"{catalog}.{name}"


def _table_in(catalog: str, name: str) -> str:
    """A table of ``[catalogs.<c>.tables]`` (``t`` or ``s.t``) by its full name."""
    return f"{catalog}.{name}" if "." in name else f"{catalog}.{MAIN}.{name}"


def _schemas_where(catalog: str | None) -> str:
    return "schemas" if catalog is None else f"catalogs.{catalog}.schemas"


def _locations(sections: dict[str, Any], root: Path, catalog: str | None = None) -> dict[str, str]:
    """Schema (``s``, or ``c.s`` in catalog ``c``) -> resolved ``location`` from ``[schemas.<s>]``."""
    out: dict[str, str] = {}
    where = _schemas_where(catalog)
    for name, section in sections.items():
        loc = section.get("location") if isinstance(section, dict) else None
        if not loc:
            continue
        schema = check_schema(name)
        if schema == MAIN:
            raise ValueError(f"{where}.{name} in {CONFIG_NAME}: main cannot have a location")
        if not isinstance(loc, str):
            raise ValueError(f"{where}.{name}.location in {CONFIG_NAME}: expected a folder or URL")
        out[_qualify(catalog, schema)] = resolve_path(loc, root)
    return out


_DATA_EXTENSIONS = {"parquet": "parquet", "csv": "csv", "json": "json", "ndjson": "json", "jsonl": "json"}


def discover_tables(location: str) -> list[tuple[str, str, str]]:
    """``[(table, path, format)]`` for the first-level folders of ``location``
    holding data files (at any depth, so Hive partitions stay in their table).
    Delta if the folder has a ``_delta_log``, else Parquet unless a folder holds only CSV or only JSON files; folders that are
    not identifiers or start with ``_`` or ``.`` are skipped."""
    base = location.replace("\\", "/").rstrip("/") + "/"
    formats: dict[str, set[str]] = {}
    deltas: set[str] = set()
    for ext, fmt in _DATA_EXTENSIONS.items():
        try:
            files = list_files(base, ext)
        except Exception:  # noqa: BLE001 - no files of that kind
            continue
        for path, _ in files:
            rel = path.replace("\\", "/")
            if not rel.startswith(base):
                continue
            folder, sep, rest = rel[len(base):].partition("/")
            if sep and folder and rest.startswith("_delta_log/"):
                deltas.add(folder)
            elif sep and folder:
                formats.setdefault(folder, set()).add(fmt)
    found = []
    for folder in sorted(set(formats) | deltas):
        if folder[0] in "_." or not _PART_RE.fullmatch(folder):
            continue
        kinds = formats.get(folder, set())
        if folder in deltas:
            fmt = "delta"
        else:
            fmt = "parquet" if "parquet" in kinds else (next(iter(kinds)) if len(kinds) == 1 else None)
        if fmt:
            found.append((folder.lower(), base + folder + "/", fmt))
    return found


_LEAD_RE = re.compile(r"(?:\s|--[^\n]*(?:\n|$)|/\*.*?\*/)*", re.DOTALL)
_NAME = r'(?:"[^"]+"|\w+)'
_DROP_RE = re.compile(
    rf"drop\s+(table|schema|catalog)\s+(?:if\s+exists\s+)?({_NAME}(?:\s*\.\s*{_NAME}){{0,2}})", re.IGNORECASE
)


def drop_target(query: str) -> tuple[str, str] | None:
    """``("table" | "schema" | "catalog", name)`` of a ``DROP`` statement, else None."""
    m = _DROP_RE.match(query, _LEAD_RE.match(query).end())
    if m is None:
        return None
    return m.group(1).lower(), re.sub(r'\s|"', "", m.group(2))


def _declared(empty: list[str], sections: dict[str, Any], catalog: str | None = None) -> dict[str, str]:
    """Schemas by name (``s``, or ``c.s`` in catalog ``c``) -> description: from
    ``[schemas.<s>]`` and from empty table sections."""
    declared = {_qualify(catalog, name): "" for name in empty}
    where = _schemas_where(catalog)
    for name, section in sections.items():
        if not isinstance(section, dict):
            raise ValueError(f"{where}.{name} in {CONFIG_NAME}: expected a section")
        declared[_qualify(catalog, check_schema(name))] = str(section.get("description", ""))
    declared.pop(_qualify(catalog, MAIN), None)
    return declared


def _catalog_sections(cfg: dict[str, Any], default: str) -> dict[str, dict[str, Any]]:
    """The ``[catalogs.<c>]`` sections by catalog name (lowercase); the default
    catalog's name and a name used twice are errors."""
    sections = cfg.get("catalogs") or {}
    if not isinstance(sections, dict):
        raise ValueError(f"catalogs in {CONFIG_NAME}: expected sections")
    out: dict[str, dict[str, Any]] = {}
    for key, section in sections.items():
        name = check_catalog(key)
        if not isinstance(section, dict):
            raise ValueError(f"catalogs.{key} in {CONFIG_NAME}: expected a section")
        if name == default:
            raise ValueError(f"catalogs.{key} in {CONFIG_NAME} has the name of the default catalog: name it another way")
        if name in out:
            raise ValueError(f"catalog {name!r} is defined twice in {CONFIG_NAME}")
        out[name] = section
    return out


def _check_unique(tables: list[TableSpec]) -> None:
    seen: set[str] = set()
    for t in tables:
        if t.name in seen:
            raise ValueError(f"table {t.name!r} is defined twice in {CONFIG_NAME}")
        seen.add(t.name)


def parse_config(text: str, root: Path) -> Workspace:
    """A workspace from the text of its ``iara.toml``."""
    cfg = tomllib.loads(text)
    section = cfg.get("workspace", {})
    name = str(section.get("name") or root.name)
    default = normalize_catalog_name(name)
    found, empty = _split_tables(cfg.get("tables") or {})
    tables = [TableSpec.from_config(n, c, root, default) for n, c in found]
    declared = _declared(empty, cfg.get("schemas") or {})
    locations = _locations(cfg.get("schemas") or {}, root)
    catalogs: dict[str, str] = {}
    for catalog, body in _catalog_sections(cfg, default).items():
        catalogs[catalog] = str(body.get("description", ""))
        found, empty = _split_tables(body.get("tables") or {}, f"catalogs.{catalog}.tables")
        tables += [TableSpec.from_config(_table_in(catalog, n), c, root, default) for n, c in found]
        declared |= _declared(empty, body.get("schemas") or {}, catalog)
        locations |= _locations(body.get("schemas") or {}, root, catalog)
    _check_unique(tables)
    warehouse = section.get("warehouse")
    return Workspace(
        root,
        name,
        tables,
        _storage_sections(cfg),
        str(warehouse) if warehouse else None,
        declared_schemas=declared,
        schema_locations=locations,
        catalogs=catalogs,
    )


_active: Workspace | None = None


def set_active(ws: Workspace | None) -> None:
    """The workspace ``load()`` returns when given no path (a kernel's, whose
    catalog may come from the Studio rather than a local file)."""
    global _active
    _active = ws


def load(path: str | os.PathLike[str] | None = None) -> Workspace:
    """Load the workspace at ``path`` (or found from ``$IARA_WORKSPACE``,
    the current directory, then the running script's directory). Without a
    ``iara.toml`` the result is an empty workspace at that directory.
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
    """The section of a table, named as it is listed: ``[tables.tpch.lineitem]`` in
    a schema, ``[catalogs.sales.tables.raw.events]`` in another catalog (a table
    of ``main`` has no schema in its section: ``[catalogs.sales.tables.orders]``)."""
    catalog, schema, table = split_name(name, "")  # the catalog is empty unless the name has three parts
    section = f"tables.{table if schema == MAIN else f'{schema}.{table}'}"
    lines = [f"\n[{f'catalogs.{catalog}.{section}' if catalog else section}]", f"path = {_toml_str(path)}"]
    if format:
        lines.append(f"format = {_toml_str(format)}")
    return "\n".join(lines) + "\n"


def schema_entry(name: str) -> str:
    """The section declaring a schema, named as it is listed: ``[schemas.<s>]``,
    or ``[catalogs.<c>.schemas.<s>]`` for ``c.s``."""
    catalog, _, schema = name.rpartition(".")
    section = f"schemas.{check_schema(schema)}"
    return f"\n[catalogs.{check_catalog(catalog)}.{section}]\n" if catalog else f"\n[{section}]\n"


def catalog_entry(name: str, description: str = "") -> str:
    """The ``[catalogs.<name>]`` section declaring a catalog."""
    desc = f"description = {_toml_str(description)}\n" if description else ""
    return f"\n[catalogs.{check_catalog(name)}]\n{desc}"


def add_table(ws: Workspace, name: str, path: str, format: str | None = None, persist: bool = True) -> tuple[TableSpec, str]:
    """Add a table to the catalog (``name``: ``t``, ``s.t`` or ``c.s.t``); ``(spec,
    toml entry)``. With ``persist`` the entry is appended to ``iara.toml`` (created
    if missing)."""
    if ws.spec(name) is not None:
        raise ValueError(f"table {name!r} already exists")
    if is_remote(path):
        rel = path
    else:
        rel = Path(os.path.relpath(path, ws.root) if Path(path).is_absolute() else path).as_posix()
    spec = TableSpec.from_config(name, {"path": rel, "format": format}, ws.root, ws.default_catalog)
    if spec.catalog is not None and spec.catalog not in ws.catalogs:
        raise ValueError(f"catalog {spec.catalog!r} does not exist")
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
