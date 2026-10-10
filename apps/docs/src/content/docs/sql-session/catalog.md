---
title: Session Catalog & Table Management
description: Registering tables, inspecting schemas, and checking column statistics.
---

### Registering Tables

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
Returns all registered table names. Tables in the default schema appear as bare names; tables in other schemas appear as `schema.table`.
```python
SessionContext.tables() -> list[str]
```

#### `SessionContext.schemas`
Returns all declared schema namespaces (defaulting to `["main"]`).
```python
SessionContext.schemas -> list[str]
```

#### `SessionContext.current_schema`
Returns the active schema used for unqualified table lookups (switchable via SQL `USE schema`).
```python
SessionContext.current_schema -> str
```

#### `SessionContext.column_stats`
Returns `(column_name, min_val, max_val, null_count, exact)` per column parsed from Parquet metadata footers.
```python
SessionContext.column_stats(name: str) -> list[tuple[str, str | None, str | None, int, bool]]
```

---

### `SessionContext.fork`

Forks the session into an independent child session sharing the current catalog snapshot. Registrations on either side afterward do not conflict.

```python
SessionContext.fork() -> SessionContext
```
