---
title: SessionContext & SQL
description: Managing relational tables, catalogs, and executing SQL.
---

`SessionContext` holds state for an interactive SQL and DataFrame environment: registered tables, named schemas, metadata statistics, and the session warehouse.

```python
import iara
```

### How it works

`ctx.sql()` parses the statement with sqlparser and plans it into the same logical plan that the DataFrame API builds, so SQL and `LazyFrame` calls share the optimizer and the executor. A `SELECT` does no work when `sql()` returns: the `LazyFrame` runs when it is collected, streamed or previewed. Table names are resolved against the session's catalogs while the statement is planned (see [Session Catalog & Table Management](/sql-session/catalog/)).

Statements that change data or the session run during the call, even without `collect()`: `CREATE TABLE ... AS`, `INSERT`, `COPY`, `UPDATE`, `DELETE`, `MERGE`, `DROP TABLE`, the `CREATE` and `DROP` statements of schemas and catalogs, and `USE`. The frame they return holds one row that describes what was done. A write to a Delta table is one commit: the data files are written first and the commit adds them, so a statement that fails leaves the table unchanged (see [Session Warehouse & DDL](/sql-session/warehouse/)). The Delta rules are described in `docs/delta.md` in the repository.

---

### Creating a Session

```python
>>> ctx = iara.SessionContext()
```

A new session has the default catalog `main`, no tables and no warehouse. Sessions do not share state: a table registered or created in one is not visible in another. `fork()` is the exception that copies a session's tables at that moment.

---

### Running SQL via `ctx.sql`

Executes an ANSI SQL statement within the session and returns a `LazyFrame`.

```python
SessionContext.sql(query: str, params: Any = None) -> LazyFrame
```

`params` binds the placeholders of the query: a list or tuple for `$1`, `$2` or `?`, and a dict for `:name` or `$name`.

#### Example
```python
>>> ctx = iara.SessionContext()
>>> ctx.register_parquet("nation", "data/nation.parquet")
>>> lf = ctx.sql("""
...     SELECT n_regionkey, count(*) as count
...     FROM nation
...     GROUP BY n_regionkey
...     ORDER BY count DESC
... """)
>>> lf.collect().show()
┌─────────────┬───────┐
│ n_regionkey │ count │
│ i64         │ u64   │
├─────────────┼───────┤
│ 1           │ 5     │
│ 0           │ 5     │
└─────────────┴───────┘
```

A statement that writes runs at once, and its frame describes the result. Without a warehouse, a created table stays in memory:

```python
>>> ctx.sql("CREATE TABLE t AS SELECT 1 AS a, 'x' AS b").collect().to_arrow().to_pylist()
[{'operation': 'create', 'table': 't', 'path': None, 'rows': 1, 'format': 'memory', 'version': None}]
```

---

### Ad-hoc SQL with `iara.sql`

To run SQL directly against Python objects without creating a persistent session, use the module-level `iara.sql()` function:

```python
>>> users = iara.from_dict({"id": [1, 2], "name": ["A", "B"]})
>>> iara.sql("SELECT name FROM u WHERE id = 1", u=users).collect().show()
┌──────┐
│ name │
│ utf8 │
├──────┤
│ A    │
└──────┘
```

Each call builds a new session. The keyword arguments are registered in it and it has no warehouse, so a `CREATE TABLE` in such a call stays in memory, and no later call sees it.
