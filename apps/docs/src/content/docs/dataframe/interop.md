---
title: DataFrame Interoperability
description: Zero-copy conversion to PyArrow, Pandas, Polars, and standard Python structures.
---

## How it works

Conversion to Arrow does not run a query. The engine's record batches are exported through Arrow's C stream interface, so `to_arrow()` returns a `pyarrow.Table` with one chunk per batch and copies no values. Measured on a 10 million row `int64` column, the call allocated no new Arrow memory. `to_pandas()` and `to_polars()` start from that same Arrow data. The stream is also exposed as `__arrow_c_stream__`, so anything that reads Arrow's stream protocol can take a `DataFrame` directly, for example `pyarrow.table(df)`. In the other direction, `from_arrow()` imports an Arrow stream without copying values (measured on the same 10 million row column, it allocated under 1 KB of Arrow memory), while `from_pandas()` and `from_dict()` first convert their input into a PyArrow table.

Conversions to Python objects (`to_pydict()`, `to_dicts()`, `rows()`, `item()`) create one Python value per cell, with nulls as `None`. Their time and memory grow with the number of cells, so use them for results that fit comfortably in the Python process and use Arrow, Pandas or Polars for large frames.

---

### `DataFrame.to_arrow`

Converts the DataFrame into a `pyarrow.Table` zero-copy via the Arrow C Stream protocol. The table has the frame's column names and types, one chunk per batch the frame holds, and shares the frame's buffers. The frame itself is not changed.

```python
DataFrame.to_arrow() -> pyarrow.Table
```

#### Example
```python
>>> import iara
>>> df = iara.from_dict({"a": [1, 2], "b": [3.0, 4.0]})
>>> table = df.to_arrow()
>>> type(table)
<class 'pyarrow.lib.Table'>
```

---

### `DataFrame.to_pandas`

Converts the DataFrame into a `pandas.DataFrame`. The conversion is `to_arrow()` followed by `pyarrow.Table.to_pandas()`, with two defaults set here: `date_as_object=False` (dates become `datetime64` columns) and `split_blocks=True` (one block per column, so null-free numeric columns can share the Arrow buffers). Decimal columns come out as pandas `ArrowDtype`, which keeps them exact.

```python
DataFrame.to_pandas(**kwargs: Any) -> pandas.DataFrame
```

#### Parameters
- **`**kwargs`**: Forwarded to `pyarrow.Table.to_pandas()`. A `types_mapper` you pass is called first; the decimal mapping applies where it returns `None`.

#### Example
```python
>>> pdf = df.to_pandas()
>>> type(pdf)
<class 'pandas.DataFrame'>
```

#### Notes
- An integer column with nulls comes out as `float64`, with the nulls as `NaN`.
- Text columns become pandas' own string values, not views of the Arrow buffers.

---

### `DataFrame.to_polars`

Converts the DataFrame into a `polars.DataFrame`. It is `to_arrow()` followed by `polars.from_arrow`, so nulls stay nulls and the column names and types carry over.

```python
DataFrame.to_polars() -> polars.DataFrame
```

#### Example
```python
>>> pldf = df.to_polars()
>>> type(pldf)
<class 'polars.dataframe.frame.DataFrame'>
```

---

### `DataFrame.to_pydict`

Exports the columns into a native Python dictionary of lists `{column_name: [values...]}`. Column order is kept, and each null becomes `None`. The values are built as Python objects, so the cost grows with the number of cells.

```python
DataFrame.to_pydict() -> dict[str, list[Any]]
```

#### Example
```python
>>> df.to_pydict()
{'a': [1, 2], 'b': [3.0, 4.0]}
```

---

### `DataFrame.to_dicts`

Exports rows as a list of dictionaries `[{col: val, ...}, ...]`, built from `to_arrow().to_pylist()`. Nulls become `None`. A frame with no rows gives `[]`.

```python
DataFrame.to_dicts() -> list[dict[str, Any]]
```

#### Example
```python
>>> df.to_dicts()
[{'a': 1, 'b': 3.0}, {'a': 2, 'b': 4.0}]
```

---

### `DataFrame.rows`

Returns rows as a list of Python tuples, in column order. It is built from `to_pydict()`, so it costs the same as that call. A frame with no rows, or with no columns, gives `[]`.

```python
DataFrame.rows() -> list[tuple[Any, ...]]
```

#### Example
```python
>>> df.rows()
[(1, 3.0), (2, 4.0)]
```

---

### `DataFrame.item`

Extracts the single scalar value of a $1 \times 1$ DataFrame, typically the result of an aggregate. Any other shape raises `ValueError` with the shape in the message.

```python
DataFrame.item() -> Any
```

#### Example
```python
>>> count_df = iara.from_dict({"cnt": [42]})
>>> count_df.item()
42
>>> df.item()
ValueError: item() requires a 1x1 frame, got shape (2, 2)
```

---

### `DataFrame.__arrow_c_stream__`

Implements Arrow's PyCapsule stream protocol, so libraries that read Arrow streams can consume the frame without a conversion step. The engine exports its batches with the frame's own schema; the `requested_schema` argument is accepted but not used.

```python
DataFrame.__arrow_c_stream__(requested_schema: Any = None) -> PyCapsule
```

#### Example
```python
>>> import pyarrow as pa
>>> pa.table(df).num_rows
2
```
