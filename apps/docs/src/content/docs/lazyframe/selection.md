---
title: LazyFrame Selection & Projections
description: Methods for projecting, adding, dropping, and renaming columns.
---

### `LazyFrame.select`

Selects and projects columns or expressions from the LazyFrame.

```python
LazyFrame.select(*exprs: Any, **named: Any) -> LazyFrame
```

#### Parameters
- **`*exprs`**: Column names or expressions to project.
- **`**named`**: Named keyword arguments that automatically apply an alias.

#### Returns
- **`LazyFrame`**: A new LazyFrame projecting only the specified columns.

#### Example
```python
>>> import workhouse
>>> from workhouse import functions as F
>>> df = workhouse.from_dict({"a": [1, 2], "b": [10.0, 20.0], "c": ["x", "y"]})
>>> df.lazy().select(
...     "a",
...     (F.col("b") * 2).alias("b_doubled"),
...     flag=F.col("c") == "x"
... ).collect().show()
┌─────┬───────────┬───────┐
│ a   │ b_doubled │ flag  │
│ i64 │ f64       │ bool  │
├─────┼───────────┼───────┤
│ 1   │ 20.0      │ true  │
│ 2   │ 40.0      │ false │
└─────┴───────────┴───────┘
```

---

### `LazyFrame.with_columns`

Appends new columns or replaces existing columns while preserving all other columns.

```python
LazyFrame.with_columns(*exprs: Any, **named: Any) -> LazyFrame
```

*Alias: `with_column`*

#### Parameters
- **`*exprs`**: Expressions with aliases to append or overwrite.
- **`**named`**: Keyword arguments defining new columns.

#### Example
```python
>>> df = workhouse.from_dict({"price": [100.0, 250.0], "discount": [0.1, 0.2]})
>>> df.lazy().with_columns(
...     net_price=F.col("price") * (1 - F.col("discount"))
... ).collect().show()
┌───────┬──────────┬───────────┐
│ price │ discount │ net_price │
│ f64   │ f64      │ f64       │
├───────┼──────────┼───────────┤
│ 100.0 │ 0.1      │ 90.0      │
│ 250.0 │ 0.2      │ 200.0     │
└───────┴──────────┴───────────┘
```

---

### `LazyFrame.drop`

Removes one or more columns from the LazyFrame.

```python
LazyFrame.drop(*columns: str) -> LazyFrame
```

#### Parameters
- **`*columns`**: Names of the columns to drop.

#### Example
```python
>>> df = workhouse.from_dict({"x": [1, 2], "secret": ["pass", "word"], "y": [3, 4]})
>>> df.lazy().drop("secret").collect().show()
┌─────┬─────┐
│ x   │ y   │
│ i64 │ i64 │
├─────┼─────┤
│ 1   │ 3   │
│ 2   │ 4   │
└─────┴─────┘
```

---

### `LazyFrame.rename`

Renames existing columns using a dictionary mapping old column names to new names.

```python
LazyFrame.rename(mapping: Mapping[str, str]) -> LazyFrame
```

#### Parameters
- **`mapping`** (`dict[str, str]`): A mapping of `{old_name: new_name}`.

#### Example
```python
>>> df = workhouse.from_dict({"old_col": [1, 2], "val": [10, 20]})
>>> df.lazy().rename({"old_col": "new_col"}).collect().columns
['new_col', 'val']
```
