---
title: Session Catalog & Table Management
description: Catalogs, schemas and tables, how names resolve, the SQL statements that manage them, registering tables and inspecting the catalog.
---

### Catalogs, Schemas and Tables

A table is named `table`, `schema.table` or `catalog.schema.table`. A catalog holds schemas, and a schema holds tables. Every catalog has a `main` schema. It always exists and cannot be dropped.

Every session has a default catalog. A plain session calls it `main`:

```python
>>> ctx = iara.SessionContext()                        # default catalog: main
>>> ctx = iara.SessionContext(default_catalog="lake")  # default catalog: lake
```

In Studio, the default catalog is named after the workspace: the `[workspace] name` of `iara.toml`, lowercased, with each character that is not a letter, digit or underscore replaced by `_`. A leading digit gets an `_` in front, and an empty name gives `main`.

The default catalog matters in two places. Names given to `register_*` and `table()` are relative to it, and tables of the default catalog are listed without their catalog name.

#### Resolution

A table name in a query resolves as follows:

- `catalog.schema.table` is exactly that table.
- `schema.table` is the table in that schema of the current catalog. A two-part name is never `catalog.table`.
- `table` is looked up in the current schema of the current catalog, then in its `main` schema.

The current catalog and schema start as the default catalog and `main`. `USE` changes them.

#### Display names

Tables of the default catalog are listed as `orders` in `main` and as `schema.table` in other schemas. Tables of any other catalog are always listed as `catalog.schema.table`, `main` included.

---

### Registering Tables

The names below are relative to the default catalog: `t`, `s.t` or `c.s.t`. `USE` does not change them.

#### `SessionContext.register`
Registers a `LazyFrame`, `DataFrame`, PyArrow table, Pandas/Polars DataFrame, or file path under a table name.
```python
SessionContext.register(name: str, obj: Any) -> SessionContext
```

#### `SessionContext.register_parquet`
Registers a Parquet file, directory, or glob pattern. When `lazy=True`, files are listed only on first query.
```python
SessionContext.register_parquet(
    name: str,
    path: str,
    storage_options: dict[str, Any] | None = None,
    lazy: bool = False
) -> SessionContext
```

#### `SessionContext.register_csv`
Registers a CSV file or directory.
```python
SessionContext.register_csv(
    name: str,
    path: str,
    has_header: bool = True,
    separator: str = ",",
    storage_options: dict[str, Any] | None = None,
    lazy: bool = False
) -> SessionContext
```

#### `SessionContext.deregister`
Removes a table registration from the session. Returns `True` if the table was present.
```python
SessionContext.deregister(name: str) -> bool
```

---

### Inspecting Catalog State

#### `SessionContext.tables`
Returns the display names of all registered tables (see Display names above).
```python
SessionContext.tables() -> list[str]
```

#### `SessionContext.catalogs`
Returns the catalogs: the default one first, then the others sorted.
```python
SessionContext.catalogs() -> list[str]
```

#### `SessionContext.current_catalog`
Returns the catalog that `USE CATALOG` or `USE c.s` selected. It is the default catalog at first.
```python
SessionContext.current_catalog() -> str
```

#### `SessionContext.default_catalog`
Returns the catalog that registrations and `table()` names belong to.
```python
SessionContext.default_catalog() -> str
```

#### `SessionContext.schemas`
Returns the schemas of a catalog, `main` first, then the others sorted. Without `catalog`, it returns the schemas of the current catalog. An unknown catalog is an error.
```python
SessionContext.schemas(catalog: str | None = None) -> list[str]
```

#### `SessionContext.current_schema`
Returns the schema that `USE` selected in the current catalog, `main` at first. Bare table names are looked up in it first.
```python
SessionContext.current_schema() -> str
```

#### `SessionContext.column_stats`
Returns `(column_name, min_val, max_val, null_count, exact)` per column parsed from Parquet metadata footers.
```python
SessionContext.column_stats(name: str) -> list[tuple[str, str | None, str | None, int, bool]]
```

---

### SQL Statements

Three-part names work in every statement that names a table: `FROM` and `JOIN`, `CREATE TABLE`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`, `DROP TABLE`, views, `OPTIMIZE`, `VACUUM`, `RESTORE`, `DESCRIBE` and time travel.

```sql
CREATE CATALOG [IF NOT EXISTS] sales;
DROP CATALOG [IF EXISTS] sales [RESTRICT | CASCADE];
USE CATALOG sales;                    -- the current catalog; its current schema becomes main

CREATE SCHEMA [IF NOT EXISTS] [sales.]raw;
DROP SCHEMA [IF EXISTS] [sales.]raw [RESTRICT | CASCADE];
USE [sales.]raw;                      -- the current schema; sales.raw also makes sales the current catalog

SHOW CATALOGS;                        -- columns: catalog, current
SHOW SCHEMAS [IN sales];              -- columns: schema, current
SHOW TABLES [IN [sales.]raw];         -- columns: schema, table, type, format
```

- `CREATE TABLE t` with a bare name creates the table in the current schema of the current catalog. `CREATE TABLE raw.events` creates it in schema `raw` of the current catalog.
- Catalog names are letters, digits and underscores, and start with a letter or `_`. They are stored in lowercase.
- `DROP CATALOG` defaults to `RESTRICT`. It refuses a catalog that has tables or schemas besides `main`. `CASCADE` removes its schemas and tables from the session; their files stay. The default catalog cannot be dropped. If the current catalog is dropped, the default catalog becomes current.
- `DROP SCHEMA` defaults to `RESTRICT`. It refuses a schema that has tables. `CASCADE` removes its tables from the session; their files stay. `main` cannot be dropped.
- `SHOW TABLES` without `IN` lists the tables of the current schema. In `SHOW CATALOGS` and `SHOW SCHEMAS`, `current` is true for the selected catalog and schema.

---

### Declaring Catalogs in iara.toml

A workspace declares its other catalogs in `iara.toml`, with `[catalogs.<name>]` sections that hold their schemas and tables. The file format is described in `docs/studio.md`, under Workspaces.

---

### `SessionContext.fork`

Forks the session into an independent child session sharing the current catalog snapshot. Registrations on either side afterward do not conflict.

```python
SessionContext.fork() -> SessionContext
```
