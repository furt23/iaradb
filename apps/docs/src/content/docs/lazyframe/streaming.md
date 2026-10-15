---
title: LazyFrame Streaming & Sinks
description: Out-of-core file sinks and batch streaming readers.
---

### `LazyFrame.sink_parquet`

Streams the query results directly into Parquet files (locally or on S3) as batches are produced by the engine, without collecting the full dataset into memory.

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
- **`path`** (`str`): Target file path or directory (supports `s3://` URLs).
- **`compression`** (`str`, default `"zstd"`): Parquet codec (`"zstd"`, `"snappy"`, `"uncompressed"`).
- **`row_group_size`** (`int`, optional): Target rows per row group.
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

Streams the query results directly to a CSV file without materializing all rows in memory.

```python
LazyFrame.sink_csv(
    path: str,
    separator: str = ",",
    include_header: bool = True,
    storage_options: dict[str, Any] | None = None
) -> int
```

#### Returns
- **`int`**: Total row count written.

#### Example
```python
>>> count = lf.sink_csv("output/export.csv", separator="\t")
```

---

### `LazyFrame.stream` / `LazyFrame.to_reader`

Starts query execution and returns a streaming reader yielding Arrow batches as they are completed. Results larger than RAM can be iterated without exhaustion.

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
