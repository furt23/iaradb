---
title: DataFrame Inspection & Properties
description: Accessing dimensions, schemas, and previewing rows.
---

## How it works

The properties read what the frame already holds: its column names, its Arrow types and its row count. None of them reads cell values. `show()` and `repr()` format the first rows as text with Arrow's table printer and leave the frame unchanged. The printed output starts with a `shape: (rows, columns)` line that gives the full row count, and ends with `... N more rows` when the frame has more rows than were printed. The text has no types, so use `schema` for them.

`head()` and `slice()` return a new `DataFrame` directly, without going through the query planner. On a frame in its natural order, the result's batches are slices of the source batches: no values are copied, but the result keeps the source buffers alive for as long as it exists. On a frame returned by `sort()`, the selected rows are gathered into new batches.

---

### `DataFrame.shape`

Returns a `(rows, columns)` tuple describing the dimensions of the table. It is the same as `(height, width)` and reads only metadata.

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

Returns the row count (`height`) and column count (`width`). `len(df)` returns the row count as well.

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

Returns the list of column names in output order. The list is a new object on each access, so editing it does not change the frame.

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

Returns a dictionary mapping column names to their data types, in column order. The type names are Arrow's, not Python's or SQL's: an integer column is `Int64`, a float column `Float64`, text `Utf8`, booleans `Boolean`, and a column holding only nulls `Null`. Nested types read as `List<Utf8>` and `Struct<a: Int64, b: List<Utf8>>`.

```python
DataFrame.schema -> dict[str, str]
```

#### Example
```python
>>> df.schema
{'x': 'Int64', 'y': 'Int64', 'z': 'Int64'}
```

---

### `DataFrame.show`

Prints a formatted ASCII table representation of the DataFrame to stdout. It prints the first `n` rows in the frame's order (for a frame returned by `sort()`, that is sorted order). Use `to_pydict()` or `to_arrow()` to get the values as data.

```python
DataFrame.show(n: int = 10) -> None
```

#### Parameters
- **`n`** (`int`, default `10`): Number of leading rows to print.

#### Example
```python
>>> df.show(2)
shape: (2, 3)
+---+---+---+
| x | y | z |
+---+---+---+
| 1 | 3 | 5 |
| 2 | 4 | 6 |
+---+---+---+
```

---

### `DataFrame.head` / `DataFrame.slice`

Returns an in-memory slice or prefix of rows as a new `DataFrame`. `head(n)` returns the first `n` rows, or all of them when the frame is shorter. `slice(offset, length)` starts at row `offset` and returns up to `length` rows; an offset past the end gives an empty frame.

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

#### Notes
- A negative `offset` or `length` raises `OverflowError`.
- On a frame in its natural order, the result shares memory with the source, so a small `head()` keeps the whole source alive while it exists.
