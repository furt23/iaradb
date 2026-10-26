---
title: DataFrame Export & Writing
description: Writing materialized DataFrames to disk and cloud storage.
---

## How it works

The writers on a `DataFrame` take the frame's record batches, which are already in memory, and write them in one call. Four formats are available: Parquet, CSV, NDJSON and Delta. To write the result of a query without holding it in memory, call the `sink_*` methods on a `LazyFrame` instead (`sink_parquet()`, `sink_csv()`, `sink_ndjson()`, `sink_delta()`); they stream the rows to the destination while the query runs.

Every write is all or nothing. A local file is written under a temporary name beside its destination and renamed into place when it is complete. An `s3://` object appears only when its multipart upload completes. A failed write leaves the previous file or table version as it was. Missing parent folders are created.

---

### `DataFrame.write_parquet`

Writes the DataFrame to Parquet format on disk or directly to an S3/R2 URL. The file is replaced if it already exists. Rows are split into row groups of `row_group_size` rows each, and the last group may be smaller. The default row group size is 131,072 rows.

```python
DataFrame.write_parquet(
    path: str,
    compression: str = "zstd",
    row_group_size: int | None = None,
    storage_options: dict[str, Any] | None = None
) -> None
```

#### Parameters
- **`path`** (`str`): Destination file path or `s3://` object URL.
- **`compression`** (`str`, default `"zstd"`): Compression codec (`"zstd"`, `"snappy"`, `"uncompressed"`). Also accepted: `"lz4"` (or `"lz4_raw"`), `"gzip"`, `"brotli"` and `"none"`. Any other value raises an error and no file is created.
- **`row_group_size`** (`int`, optional): Target rows per Parquet row group.
- **`storage_options`** (`dict`, optional): S3 endpoint or authentication options. Keys use the object_store names (for example `region`, `endpoint`, `access_key_id`) and are lowercased; values are converted to text, booleans become `true` or `false`, and `None` values are dropped.

#### Example
```python
>>> import iara
>>> df = iara.from_dict({"a": [1, 2, 3]})
>>> df.write_parquet("data/output.parquet")
```

---

### `DataFrame.write_csv`

Writes the DataFrame to a CSV file, one line per row. The header line holds the column names unless `include_header` is `False`. Nulls are written as empty fields.

```python
DataFrame.write_csv(
    path: str,
    separator: str = ",",
    include_header: bool = True,
    storage_options: dict[str, Any] | None = None
) -> None
```

#### Parameters
- **`path`** (`str`): Destination path or URL.
- **`separator`** (`str`, default `","`): Column separator character.
- **`include_header`** (`bool`, default `True`): Whether to include the header row.

#### Example
```python
>>> df.write_csv("data/output.csv", separator="\t")
```

#### Notes
- Only the first byte of `separator` is used, and an empty string falls back to `","`.
- A null in a file with a single column is written as `""`, so the line is not empty.

---

### `DataFrame.write_ndjson`

Writes the DataFrame as newline-delimited JSON: one JSON object per row, keyed by column name. Nulls are written as `null`. It takes a local path or object store URL, like the other writers.

```python
DataFrame.write_ndjson(
    path: str,
    storage_options: dict[str, Any] | None = None
) -> None
```

#### Example
```python
>>> df = iara.from_dict({"a": [1, None], "s": ["x", "y"]})
>>> df.write_ndjson("data/output.ndjson")
```

---

### `DataFrame.write_delta`

Writes the DataFrame as a Delta table, at a folder or `s3://` URL. `mode` decides what happens when a table is already there: `"error"` (the default) fails, `"append"` adds the rows, `"overwrite"` replaces the rows, and `"ignore"` writes nothing. The replaced files stay in the table's log, so older versions can still be read. `partition_by` creates Hive-style `column=value` folders for a new table; later writes keep the table's partitioning. `schema_mode="merge"` adds new columns to the table on append or overwrite. The data files are added by a single commit, so a failed write leaves the table unchanged.

```python
DataFrame.write_delta(
    path: str,
    mode: str = "error",
    partition_by: str | Sequence[str] | None = None,
    storage_options: dict[str, Any] | None = None,
    schema_mode: str | None = None
) -> None
```

#### Parameters
- **`path`** (`str`): Table folder or `s3://` URL.
- **`mode`** (`str`, default `"error"`): `"error"`, `"append"`, `"overwrite"` or `"ignore"`.
- **`partition_by`** (`str` or list of `str`, optional): Columns to partition a new table by.
- **`storage_options`** (`dict`, optional): Same as for `write_parquet`.
- **`schema_mode`** (`str`, optional): `None` or `"merge"`. Any other value raises `ValueError`.

#### Example
```python
>>> df.write_delta("data/sales", mode="append")
```
