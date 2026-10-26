---
title: I/O & Constructor Functions
description: Global functions for loading, creating, and querying data.
---

## How it works

Every file source starts from a path, a folder, a glob pattern, or an `s3://` URL, and expands it into a sorted list of files with the same rule as `iara.list_files`: a folder is searched recursively for files of the reader's extension, and a glob matches its own pattern. The `scan_*` functions check that the path exists (a missing path raises `IaraError` when the call runs), read what the schema needs (the Parquet footers, or the start of each CSV and JSON file), and return a `LazyFrame`. No rows are read until the plan runs.

Filters and column selections are pushed into the scan. Parquet row groups whose min/max statistics cannot match a predicate are skipped, only the referenced columns are decoded, and `count(*)` with no columns is answered from file metadata. A Hive-style `key=value` folder becomes columns, and a filter on one of them skips whole files. When the plan runs, each Parquet row group, and each byte range of a CSV or NDJSON file, is a unit of work that the thread pool processes in parallel. CSV ranges are cut only at record boundaries, so a quoted field that contains a newline is not split. `explain()` shows what was pushed into the scan:

```python
>>> import iara
>>> from iara import functions as F
>>> plan = iara.scan_parquet("data/users.parquet").filter(F.col("age") > 30).select("name", "age")
>>> print(plan.explain())
== Optimized logical plan ==
Filter: age > 30
  Scan: data/users.parquet [parquet] projection=[name, age] pruning_filters=[age > 30]

== Physical plan ==
Filter: (age@1 > 30)
  ParquetScan[users, files=1, row_groups=1/1, morsels=1, columns=2]
```

The `read_*` functions and the `from_*` constructors return a `DataFrame` in memory. `read_*` is the matching scan followed by `collect()`, so the whole result is held in memory. `from_arrow` reads the whole Arrow stream when it is called, and `from_pandas` and `from_dict` convert their input through pyarrow. For results larger than memory, keep the plan lazy and write it with a `sink_*` method of `LazyFrame`.

CSV column types are inferred from the first `infer_schema_length` rows of the file. Fields that are empty, or match `null_values`, read as null. Dates and timestamps written as text are parsed unless `try_parse_dates=False`. `schema_overrides` (or `dtypes`) forces the type of a column. Schemas report Arrow type names, such as `Int64`, `Float64`, `Utf8`, and `Int32`.

---

### `iara.scan_parquet`

<span class="api-badge api-badge-lazy">Lazy</span>

Lazily scans a Parquet file, a directory of Parquet files, a glob pattern, or an object store URL (`s3://...`).

```python
iara.scan_parquet(path: str, storage_options: dict[str, Any] | None = None) -> LazyFrame
```

The schema comes from the file footers, which are read when the call runs. The files of a folder or a glob form one table. Rows are read only when the plan runs, and then only the row groups that the pushed-down filters cannot rule out.

#### Parameters
- **`path`** (`str`): File path, folder, glob pattern (e.g. `data/**/*.parquet`), or `s3://` URI.
- **`storage_options`** (`dict`, optional): Endpoint, region, credentials or custom S3 configuration.

#### Returns
- **`LazyFrame`**: A lazy query plan representation.

#### Notes
- For `s3://` URLs, the keys are those of `iara.storage`: `region`, `endpoint` (for S3-compatible services such as Cloudflare R2), `allow_http`, `skip_signature` (public buckets), `access_key_id`, `secret_access_key`, and `session_token`. Without them, credentials come from the `AWS_*` environment variables or the EC2 instance profile.

#### Example
```python
>>> import iara
>>> lf = iara.scan_parquet("data/users.parquet")
>>> lf.schema
{'id': 'Int64', 'name': 'Utf8View', 'age': 'Int32'}
```

---

### `iara.scan_csv`

<span class="api-badge api-badge-lazy">Lazy</span>

Lazily scans a CSV file or directory of CSV files.

```python
iara.scan_csv(
    path: str,
    has_header: bool = True,
    separator: str = ",",
    infer_schema_length: int = 10000,
    parallel: bool = True,
    storage_options: dict[str, Any] | None = None,
    **options: Any
) -> LazyFrame
```

The header gives the column names when `has_header` is true. The schema is inferred when the call runs, from the first `infer_schema_length` rows. With `parallel=True` each file is split into byte ranges that are parsed at the same time, and a split never falls inside a quoted field.

#### Parameters
- **`path`** (`str`): File path, directory, or object store URL.
- **`has_header`** (`bool`, default `True`): Whether the first row contains column headers.
- **`separator`** (`str`, default `","`): Field delimiter character.
- **`infer_schema_length`** (`int`, default `10000`): Maximum rows sampled for automatic schema inference.
- **`parallel`** (`bool`, default `True`): Enables multi-threaded parallel file chunk parsing.
- **`storage_options`** (`dict`, optional): Object store settings.
- **`**options`**: The other CSV read options of `iara.file_io`: `quote_char`, `escape`, `null_values`, `skip_rows`, `comment` (or `comment_prefix`), `columns` (names to keep, in this order), `schema_overrides` (or `dtypes`), `encoding` (`"utf8"` or `"utf8-lossy"`), and `try_parse_dates`.

#### Returns
- **`LazyFrame`**: A lazy plan representing the CSV scan.

#### Notes
- For a remote file, the byte ranges are cut by looking for quotes in the sample read for the schema. If a quote first appears after the sample, pass `parallel=False`.

#### Example
```python
>>> lf = iara.scan_csv("data/metrics.csv", separator="\t")
>>> lf.columns
['timestamp', 'metric_name', 'value']
```

---

### `iara.read_parquet`

<span class="api-badge api-badge-eager">Eager</span>

Eagerly reads Parquet files into a materialized in-memory `DataFrame`. Equivalent to `iara.scan_parquet(...).collect()`.

```python
iara.read_parquet(path: str, storage_options: dict[str, Any] | None = None) -> DataFrame
```

The whole result is held in memory. For a result that is larger than memory, use `scan_parquet` and write it with `sink_parquet`.

#### Example
```python
>>> df = iara.read_parquet("data/small.parquet")
>>> df.show(2)
shape: (2, 2)
+----+-------+
| id | value |
+----+-------+
| 1  | 10.5  |
| 2  | 20.0  |
+----+-------+
```

---

### `iara.read_csv`

<span class="api-badge api-badge-eager">Eager</span>

Eagerly reads CSV files into an in-memory `DataFrame`. Equivalent to `iara.scan_csv(path, **kwargs).collect()`, with the same keyword arguments as `scan_csv`.

```python
iara.read_csv(path: str, **kwargs: Any) -> DataFrame
```

#### Example
```python
>>> df = iara.read_csv("data/cities.csv")
>>> len(df)
250
```

---

### `iara.from_dict`

<span class="api-badge api-badge-eager">Eager</span>

Constructs an in-memory `DataFrame` from a dictionary mapping column names to sequences.

```python
iara.from_dict(data: Mapping[str, Sequence[Any]]) -> DataFrame
```

Each sequence becomes a column, with the type pyarrow infers from its values (Python integers are `Int64`, floats `Float64`, strings `Utf8`). `None` becomes null. The values are copied into the engine.

#### Example
```python
>>> df = iara.from_dict({"item": ["apple", "banana"], "stock": [50, 120]})
>>> df.show()
shape: (2, 2)
+--------+-------+
| item   | stock |
+--------+-------+
| apple  | 50    |
| banana | 120   |
+--------+-------+
```

---

### `iara.from_arrow`

<span class="api-badge api-badge-eager">Eager</span>

Imports any tabular object implementing the Arrow C Stream protocol (`pyarrow.Table`, `pyarrow.RecordBatchReader`, etc.) zero-copy.

```python
iara.from_arrow(data: Any) -> DataFrame
```

The stream is read to its end when the call runs. The record batches are kept as they are: no values are converted, and the buffers are shared with the Arrow object rather than copied.

#### Example
```python
>>> import pyarrow as pa
>>> table = pa.table({"x": [1, 2], "y": [3.5, 4.5]})
>>> df = iara.from_arrow(table)
>>> df.shape
(2, 2)
```

---

### `iara.from_pandas`

<span class="api-badge api-badge-eager">Eager</span>

Constructs an Iara `DataFrame` from a Pandas DataFrame without index preservation.

```python
iara.from_pandas(df: Any) -> DataFrame
```

The conversion is pyarrow's `Table.from_pandas(df, preserve_index=False)`, so the data is copied. The index is dropped, and NaN in a float column becomes null.

#### Example
```python
>>> import pandas as pd
>>> pdf = pd.DataFrame({"a": [10, 20], "b": ["x", "y"]})
>>> df = iara.from_pandas(pdf)
>>> df.columns
['a', 'b']
```

---

### `iara.from_polars`

<span class="api-badge api-badge-eager">Eager</span>

Constructs an Iara `DataFrame` from a Polars DataFrame via the Arrow C Stream interface.

```python
iara.from_polars(df: Any) -> DataFrame
```

The Polars frame is exported with its `to_arrow()` method and imported as `from_arrow` does. Polars string columns arrive as `LargeUtf8`.

#### Example
```python
>>> import polars as pl
>>> pldf = pl.DataFrame({"k": ["alpha", "beta"], "v": [1, 2]})
>>> df = iara.from_polars(pldf)
>>> df.height
2
```

---

### `iara.sql`

<span class="api-badge api-badge-lazy">Lazy</span>

Executes an ANSI SQL query against passed frames or registered tables.

```python
iara.sql(query: str, params: Any = None, **tables: Any) -> LazyFrame
```

Each call plans the statement in a new SQL session. Every keyword argument is registered as a table of that name, so a table lives only for that call. A table can be a `DataFrame`, a `LazyFrame`, a pyarrow, polars or pandas object, or a file path: a `.csv` path is read as CSV, a `.json`, `.ndjson` or `.jsonl` path as JSON, and any other path as Parquet. The result is a `LazyFrame`, so the query runs when it is collected. Tables that must outlive one call are registered on a [`SessionContext`](/sql-session/).

#### Parameters
- **`query`** (`str`): SQL statement.
- **`params`** (`list`, `tuple` or `dict`, optional): Values for the placeholders of the query: a list or tuple binds `$1`, `$2` or `?` by position, and a dict binds `:name` or `$name`. Values may be int, float, str, bool, None, bytes, date, datetime and Decimal.
- **`**tables`**: Named keyword arguments binding DataFrames or LazyFrames to SQL table aliases.

#### Returns
- **`LazyFrame`**: A lazy query plan that executes when collected.

#### Example
```python
>>> orders = iara.from_dict({"order_id": [101, 102], "amount": [45.0, 80.0]})
>>> lf = iara.sql("SELECT order_id, amount * 1.05 AS total FROM t WHERE amount > 50", t=orders)
>>> lf.collect().show()
shape: (1, 2)
+----------+-------+
| order_id | total |
+----------+-------+
| 102      | 84.0  |
+----------+-------+
```

With placeholders, the values are passed separately from the text:

```python
>>> orders = iara.from_dict({"order_id": [101, 102, 103], "amount": [45.0, 80.0, 120.0]})
>>> iara.sql("SELECT order_id, amount FROM t WHERE amount > $1 ORDER BY order_id", [50.0], t=orders).collect().to_pydict()
{'order_id': [102, 103], 'amount': [80.0, 120.0]}
```

---

### `iara.workspace`

Loads an engine session configured from a local or parent `iara.toml` catalog file.

```python
iara.workspace(path: str | None = None) -> Any
```

With a path, the workspace is the nearest `iara.toml` at or above it. Without one, it is the first workspace found from `$IARA_WORKSPACE`, then from the current directory upward, then from the running script's directory. Without an `iara.toml`, the result is an empty workspace at that directory. The tables declared in `iara.toml` are registered in the workspace's session: `ws.table(name)` returns one as a `LazyFrame`, and `ws.sql(query, params, **tables)` runs SQL against them.

#### Example
```python
>>> ws = iara.workspace()  # a project whose iara.toml declares the table orders
>>> ws.session.tables()
['orders']
>>> lf = ws.table("orders")
```
