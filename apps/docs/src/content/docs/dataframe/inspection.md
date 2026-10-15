---
title: DataFrame Inspection & Properties
description: Accessing dimensions, schemas, and previewing rows.
---

### `DataFrame.shape`

Returns a `(rows, columns)` tuple describing the dimensions of the table.

```python
DataFrame.shape -> tuple[int, int]
```

#### Example
```python
>>> import iara
>>> df = iara.from_dict({"x": [1, 2], "y": [3, 4], "z": [5, 6]})
>>> df.shape
(2, 3)
```

---

### `DataFrame.height` / `DataFrame.width`

Returns the row count (`height`) and column count (`width`).

```python
DataFrame.height -> int
DataFrame.width -> int
```

#### Example
```python
>>> df.height
2
>>> df.width
3
```

---

### `DataFrame.columns`

Returns the list of column names in output order.

```python
DataFrame.columns -> list[str]
```

#### Example
```python
>>> df.columns
['x', 'y', 'z']
```

---

### `DataFrame.schema`

Returns a dictionary mapping column names to their data types.

```python
DataFrame.schema -> dict[str, str]
```

#### Example
```python
>>> df.schema
{'x': 'int64', 'y': 'int64', 'z': 'int64'}
```

---

### `DataFrame.show`

Prints a formatted ASCII table representation of the DataFrame to stdout.

```python
DataFrame.show(n: int = 10) -> None
```

#### Parameters
- **`n`** (`int`, default `10`): Number of leading rows to print.

#### Example
```python
>>> df.show(2)
┌─────┬─────┬─────┐
│ x   │ y   │ z   │
│ i64 │ i64 │ i64 │
├─────┼─────┼─────┤
│ 1   │ 3   │ 5   │
│ 2   │ 4   │ 6   │
└─────┴─────┴─────┘
```

---

### `DataFrame.head` / `DataFrame.slice`

Returns an in-memory slice or prefix of rows as a new `DataFrame`.

```python
DataFrame.head(n: int = 5) -> DataFrame
DataFrame.slice(offset: int, length: int) -> DataFrame
```

#### Example
```python
>>> sub = df.head(1)
>>> sub.height
1
```
