---
title: SessionContext & SQL
description: Managing relational tables, catalogs, and executing SQL.
---

`SessionContext` holds state for an interactive SQL and DataFrame environment: registered tables, named schemas, metadata statistics, and the session warehouse.

```python
import workhouse
```

---

### Creating a Session

```python
>>> ctx = workhouse.SessionContext()
```

---

### Running SQL via `ctx.sql`

Executes an ANSI SQL statement within the session and returns a `LazyFrame`.

```python
SessionContext.sql(query: str) -> LazyFrame
```

#### Example
```python
>>> ctx = workhouse.SessionContext()
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

---

### Ad-hoc SQL with `workhouse.sql`

To run SQL directly against Python objects without creating a persistent session, use the module-level `workhouse.sql()` function:

```python
>>> users = workhouse.from_dict({"id": [1, 2], "name": ["A", "B"]})
>>> workhouse.sql("SELECT name FROM u WHERE id = 1", u=users).collect().show()
┌──────┐
│ name │
│ utf8 │
├──────┤
│ A    │
└──────┘
```
