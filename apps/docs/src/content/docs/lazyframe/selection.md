---
title: LazyFrame Selection & Projections
description: Methods for projecting, adding, dropping, and renaming columns.
---

## How it works

Selection methods are projections: each one adds a step that computes a new set of columns from the input, one batch at a time. None of them changes the number of rows, and the row order of the input is kept. `select()` returns only the expressions it is given, in the order given. `with_columns()` returns every existing column: an expression whose name matches an existing column replaces that column in place, and a new name is appended after the existing columns. `drop()` and `rename()` are projections with fewer expressions.

The plan is known in full before execution, so the optimizer removes the columns that no later step reads and asks the source for only the rest. On a Parquet scan, the columns that are not read are not decoded. The explain output lists the columns each scan reads (`projection=[id, v]`).

## Methods

### `LazyFrame.select`

Selects and projects columns or expressions from the LazyFrame. A bare string is a column name (the same as `F.col(name)`), and a keyword argument names its expression, so `flag=expr` is the same as `expr.alias("flag")`. The output has exactly those columns, in the order given. Duplicate output names are kept as given.

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
>>> import iara
>>> from iara import functions as F
>>> df = iara.from_dict({"a": [1, 2], "b": [10.0, 20.0], "c": ["x", "y"]})
>>> df.lazy().select(
...     "a",
...     (F.col("b") * 2).alias("b_doubled"),
...     flag=F.col("c") == "x"
... ).collect().show()
shape: (2, 3)
+---+-----------+-------+
| a | b_doubled | flag  |
+---+-----------+-------+
| 1 | 20.0      | true  |
| 2 | 40.0      | false |
+---+-----------+-------+
```

---

### `LazyFrame.with_columns`

Appends new columns or replaces existing columns while preserving all other columns. An existing column is replaced where it stands, so its position does not change; new columns come after the existing ones.

```python
LazyFrame.with_columns(*exprs: Any, **named: Any) -> LazyFrame
```

*Alias: `with_column`*

#### Parameters
- **`*exprs`**: Expressions with aliases to append or overwrite.
- **`**named`**: Keyword arguments defining new columns.

#### Example
```python
>>> df = iara.from_dict({"price": [100.0, 250.0], "discount": [0.1, 0.2]})
>>> df.lazy().with_columns(
...     net_price=F.col("price") * (1 - F.col("discount"))
... ).collect().show()
shape: (2, 3)
+-------+----------+-----------+
| price | discount | net_price |
+-------+----------+-----------+
| 100.0 | 0.1      | 90.0      |
| 250.0 | 0.2      | 200.0     |
+-------+----------+-----------+
```

---

### `LazyFrame.drop`

Removes one or more columns from the LazyFrame. A name that is not a column of the frame is ignored without an error, so check `.columns` after the step if a name might be misspelled.

```python
LazyFrame.drop(*columns: str) -> LazyFrame
```

#### Parameters
- **`*columns`**: Names of the columns to drop.

#### Example
```python
>>> df = iara.from_dict({"x": [1, 2], "secret": ["pass", "word"], "y": [3, 4]})
>>> df.lazy().drop("secret").collect().show()
shape: (2, 2)
+---+---+
| x | y |
+---+---+
| 1 | 3 |
| 2 | 4 |
+---+---+
```

---

### `LazyFrame.rename`

Renames existing columns using a dictionary mapping old column names to new names. The data is not changed, only the names. A key that is not a column of the frame is ignored without an error, as with `drop()`.

```python
LazyFrame.rename(mapping: Mapping[str, str]) -> LazyFrame
```

#### Parameters
- **`mapping`** (`dict[str, str]`): A mapping of `{old_name: new_name}`.

#### Example
```python
>>> df = iara.from_dict({"old_col": [1, 2], "val": [10, 20]})
>>> df.lazy().rename({"old_col": "new_col"}).collect().columns
['new_col', 'val']
```
