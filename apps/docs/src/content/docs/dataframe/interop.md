---
title: DataFrame Interoperability
description: Zero-copy conversion to PyArrow, Pandas, Polars, and standard Python structures.
---

### `DataFrame.to_arrow`

Converts the DataFrame into a `pyarrow.Table` zero-copy via the Arrow C Stream protocol.

```python
DataFrame.to_arrow() -> pyarrow.Table
```

#### Example
```python
>>> import workhouse
>>> df = workhouse.from_dict({"a": [1, 2], "b": [3.0, 4.0]})
>>> table = df.to_arrow()
>>> type(table)
<class 'pyarrow.lib.Table'>
```

---

### `DataFrame.to_pandas`

Converts the DataFrame into a `pandas.DataFrame`.

```python
DataFrame.to_pandas(**kwargs: Any) -> pandas.DataFrame
```

#### Parameters
- **`**kwargs`**: Forwarded directly to `pyarrow.Table.to_pandas()`.

#### Example
```python
>>> pdf = df.to_pandas()
>>> type(pdf)
<class 'pandas.core.frame.DataFrame'>
```

---

### `DataFrame.to_polars`

Converts the DataFrame into a `polars.DataFrame` zero-copy.

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

Exports the columns into a native Python dictionary of lists `{column_name: [values...]}`.

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

Exports rows as a list of dictionaries `[{col: val, ...}, ...]`.

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

Returns rows as a list of Python tuples.

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

Extracts the single scalar value of a $1 \times 1$ DataFrame. Raises `ValueError` if dimensions are not exactly $(1, 1)$.

```python
DataFrame.item() -> Any
```

#### Example
```python
>>> count_df = workhouse.from_dict({"cnt": [42]})
>>> count_df.item()
42
```
