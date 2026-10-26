---
title: LazyFrame Streaming & Sinks
description: Out-of-core file sinks and batch streaming readers.
---

## How it works

Sinks and streams run the same pipeline as `collect()`, but the batches go to a file or to the caller as they are produced, so the result does not have to fit in memory. The output keeps the order `collect()` would give: a morsel's batches are written once every earlier morsel has been written. A stream holds at most four batches between the query and the reader, so a slow consumer slows the query down instead of filling memory.

For Parquet, the batches are encoded into row groups on a separate pool of threads, and each row group holds up to `row_group_size` rows (131072 by default). A sink returns the number of rows it wrote. `sink_delta()` writes its data files first and adds them to the table in one commit, so a failing query leaves the table as it was.

A `LazyFrame` is still a plan: nothing is written until the sink method is called, and each sink or stream plans and runs the query again.

## Sinks

### `LazyFrame.sink_parquet`

Streams the query results directly into Parquet files (a local path or an `s3://` URL) as batches are produced by the engine, without collecting the full dataset into memory.

```python
LazyFrame.sink_parquet(
    path: str,
    compression: str = "zstd",
    row_group_size: int | None = None,
    storage_options: dict[str, Any] | None = None,
    partition_by: str | Sequence[str] | None = None
) -> int
```

#### Parameters
- **`path`** (`str`): Target file path or directory (supports `s3://` URLs). With `partition_by`, a directory.
- **`compression`** (`str`, default `"zstd"`): Parquet codec: `"zstd"`, `"snappy"`, `"lz4"`, `"gzip"`, `"brotli"`, or `"uncompressed"` (also `"none"`). An unknown name is an error.
- **`row_group_size`** (`int`, optional): Target rows per row group. Default 131072.
- **`storage_options`** (`dict`, optional): S3/R2 storage settings.
- **`partition_by`** (`str | list[str]`, optional): Column names for Hive-style directory partitioning (`year=2024/region=north/...`).

#### Returns
- **`int`**: Total number of rows written.

#### Example
```python
>>> import iara
>>> from iara import functions as F
>>> lf = iara.scan_parquet("data/input.parquet")
>>> total_rows = lf.filter(F.col("active") == True).sink_parquet("data/active.parquet")
>>> print(f"Wrote {total_rows} rows to output.")
```

---

### `LazyFrame.sink_csv`

Streams the query results directly to a CSV file without materializing all rows in memory. The header row is written first, unless `include_header=False`. Null values are written as empty fields.

```python
LazyFrame.sink_csv(
    path: str,
    separator: str = ",",
    include_header: bool = True,
    storage_options: dict[str, Any] | None = None
) -> int
```

#### Parameters
- **`separator`** (`str`, default `","`): Field separator. Only its first byte is used.

#### Returns
- **`int`**: Total row count written.

#### Example
```python
>>> count = lf.sink_csv("output/export.csv", separator="\t")
```

---

### `LazyFrame.sink_ndjson`

Streams the query results to a newline-delimited JSON file, one object per row. Numbers and booleans are JSON values, nulls are `null`, and every other type (dates, for example) is written as a string.

```python
LazyFrame.sink_ndjson(
    path: str,
    storage_options: dict[str, Any] | None = None
) -> int
```

#### Returns
- **`int`**: Total number of rows written.

---

### `LazyFrame.sink_delta`

Writes the query results to a Delta table while they are produced. The table is a path or an `s3://` URL. The data files are written first and added to the table by a single commit.

```python
LazyFrame.sink_delta(
    path: str,
    mode: str = "error",
    partition_by: str | Sequence[str] | None = None,
    storage_options: dict[str, Any] | None = None,
    schema_mode: str | None = None
) -> dict[str, Any]
```

#### Parameters
- **`mode`** (`str`, default `"error"`): `"error"` requires that the table does not exist, `"append"` adds rows, `"overwrite"` replaces the rows (the old files stay in the log, for time travel), and `"ignore"` writes nothing when the table exists.
- **`partition_by`** (`str | list[str]`, optional): Partitioning of a new table. A later write keeps the table's partitioning.
- **`schema_mode`** (`str`, optional): `"merge"` adds the result's new columns to the table on append or overwrite.

#### Returns
- **`dict`**: `{"version", "files", "rows", "skipped"}` for the commit.

---

## Streams

### `LazyFrame.stream` / `LazyFrame.to_reader`

Starts query execution and returns a streaming reader yielding Arrow batches as they are completed. Results larger than RAM can be iterated without exhaustion. `to_reader()` returns a `pyarrow.RecordBatchReader`; `stream()` returns a `ResultStream`, which has `schema`, `batches()` and `reader()`, and whose `profile()` is available once the result has been read to the end. The result can be read once.

```python
LazyFrame.stream() -> ResultStream
LazyFrame.to_reader() -> pyarrow.RecordBatchReader
```

#### Example
```python
>>> reader = lf.to_reader()
>>> for batch in reader:
...     print(f"Read batch of {batch.num_rows} rows")
```

#### Example: Total Rows from the Reader
```python
>>> iara.from_dict({"a": [1, 2]}).lazy().to_reader().read_all().num_rows
2
```

---

### `LazyFrame.iter_batches`

Iterates over output `pyarrow.RecordBatch` instances as they flow out of the execution pipeline.

```python
LazyFrame.iter_batches() -> Iterator[pyarrow.RecordBatch]
```

#### Example
```python
>>> for batch in lf.iter_batches():
...     process_batch(batch)
```
