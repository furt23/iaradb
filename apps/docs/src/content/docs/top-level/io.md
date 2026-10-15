---
title: I/O & Constructor Functions
description: Global functions for loading, creating, and querying data.
---

### `workhouse.scan_parquet`

<span class="api-badge api-badge-lazy">Lazy</span>

Lazily scans a Parquet file, a directory of Parquet files, a glob pattern, or an object store URL (`s3://...`).

```python
workhouse.scan_parquet(path: str, storage_options: dict[str, Any] | None = None) -> LazyFrame
```

#### Parameters
- **`path`** (`str`): File path, folder, glob pattern (e.g. `data/**/*.parquet`), or `s3://` URI.
- **`storage_options`** (`dict`, optional): Endpoint, region, credentials or custom S3 configuration.

#### Returns
- **`LazyFrame`**: A lazy query plan representation.

#### Example
```python
>>> import workhouse
>>> lf = workhouse.scan_parquet("data/users.parquet")
>>> lf.schema
{'id': 'int64', 'name': 'utf8', 'age': 'int32'}
```

---

### `workhouse.scan_csv`

<span class="api-badge api-badge-lazy">Lazy</span>

Lazily scans a CSV file or directory of CSV files.

```python
workhouse.scan_csv(
    path: str,
    has_header: bool = True,
    separator: str = ",",
    infer_schema_length: int = 10000,
    parallel: bool = True,
    storage_options: dict[str, Any] | None = None
) -> LazyFrame
```

#### Parameters
- **`path`** (`str`): File path, directory, or object store URL.
- **`has_header`** (`bool`, default `True`): Whether the first row contains column headers.
- **`separator`** (`str`, default `","`): Field delimiter character.
- **`infer_schema_length`** (`int`, default `10000`): Maximum rows sampled for automatic schema inference.
- **`parallel`** (`bool`, default `True`): Enables multi-threaded parallel file chunk parsing.
- **`storage_options`** (`dict`, optional): Object store settings.

#### Returns
- **`LazyFrame`**: A lazy plan representing the CSV scan.

#### Example
```python
>>> lf = workhouse.scan_csv("data/metrics.csv", separator="\t")
>>> lf.columns
['timestamp', 'metric_name', 'value']
```

---

### `workhouse.read_parquet`

<span class="api-badge api-badge-eager">Eager</span>

Eagerly reads Parquet files into a materialized in-memory `DataFrame`. Equivalent to `workhouse.scan_parquet(...).collect()`.

```python
workhouse.read_parquet(path: str, storage_options: dict[str, Any] | None = None) -> DataFrame
```

#### Example
```python
>>> df = workhouse.read_parquet("data/small.parquet")
>>> df.show(2)
┌─────┬───────┐
│ id  │ value │
│ i64 │ f64   │
├─────┼───────┤
│ 1   │ 10.5  │
│ 2   │ 20.0  │
└─────┴───────┘
```

---

### `workhouse.read_csv`

<span class="api-badge api-badge-eager">Eager</span>

Eagerly reads CSV files into an in-memory `DataFrame`.

```python
workhouse.read_csv(path: str, **kwargs: Any) -> DataFrame
```

#### Example
```python
>>> df = workhouse.read_csv("data/cities.csv")
>>> len(df)
250
```

---

### `workhouse.from_dict`

<span class="api-badge api-badge-eager">Eager</span>

Constructs an in-memory `DataFrame` from a dictionary mapping column names to sequences.

```python
workhouse.from_dict(data: Mapping[str, Sequence[Any]]) -> DataFrame
```

#### Example
```python
>>> df = workhouse.from_dict({"item": ["apple", "banana"], "stock": [50, 120]})
>>> df.show()
┌────────┬───────┐
│ item   │ stock │
│ utf8   │ i64   │
├────────┼───────┤
│ apple  │ 50    │
│ banana │ 120   │
└────────┴───────┘
```

---

### `workhouse.from_arrow`

<span class="api-badge api-badge-eager">Eager</span>

Imports any tabular object implementing the Arrow C Stream protocol (`pyarrow.Table`, `pyarrow.RecordBatchReader`, etc.) zero-copy.

```python
workhouse.from_arrow(data: Any) -> DataFrame
```

#### Example
```python
>>> import pyarrow as pa
>>> table = pa.table({"x": [1, 2], "y": [3.5, 4.5]})
>>> df = workhouse.from_arrow(table)
>>> df.shape
(2, 2)
```

---

### `workhouse.from_pandas`

<span class="api-badge api-badge-eager">Eager</span>

Constructs a Workhouse `DataFrame` from a Pandas DataFrame without index preservation.

```python
workhouse.from_pandas(df: Any) -> DataFrame
```

#### Example
```python
>>> import pandas as pd
>>> pdf = pd.DataFrame({"a": [10, 20], "b": ["x", "y"]})
>>> df = workhouse.from_pandas(pdf)
>>> df.columns
['a', 'b']
```

---

### `workhouse.from_polars`

<span class="api-badge api-badge-eager">Eager</span>

Constructs a Workhouse `DataFrame` from a Polars DataFrame via the Arrow C Stream interface.

```python
workhouse.from_polars(df: Any) -> DataFrame
```

#### Example
```python
>>> import polars as pl
>>> pldf = pl.DataFrame({"k": ["alpha", "beta"], "v": [1, 2]})
>>> df = workhouse.from_polars(pldf)
>>> df.height
2
```

---

### `workhouse.sql`

<span class="api-badge api-badge-lazy">Lazy</span>

Executes an ANSI SQL query against passed frames or registered tables.

```python
workhouse.sql(query: str, **tables: Any) -> LazyFrame
```

#### Parameters
- **`query`** (`str`): SQL statement.
- **`**tables`**: Named keyword arguments binding DataFrames or LazyFrames to SQL table aliases.

#### Returns
- **`LazyFrame`**: A lazy query plan that executes when collected.

#### Example
```python
>>> orders = workhouse.from_dict({"order_id": [101, 102], "amount": [45.0, 80.0]})
>>> lf = workhouse.sql("SELECT order_id, amount * 1.05 AS total FROM t WHERE amount > 50", t=orders)
>>> lf.collect().show()
┌──────────┬───────┐
│ order_id │ total │
│ i64      │ f64   │
├──────────┼───────┤
│ 102      │ 84.0  │
└──────────┴───────┘
```

---

### `workhouse.workspace`

Loads an engine session configured from a local or parent `workhouse.toml` catalog file.

```python
workhouse.workspace(path: str | None = None) -> Any
```

#### Example
```python
>>> ws = workhouse.workspace()
>>> ws.tables()
['nation', 'region', 'customer', 'orders']
>>> lf = ws.table("orders")
```
