---
title: DataFrame Export & Writing
description: Writing materialized DataFrames to disk and cloud storage.
---

### `DataFrame.write_parquet`

Writes the DataFrame to Parquet format on disk or directly to an S3/R2 URL.

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
- **`compression`** (`str`, default `"zstd"`): Compression codec (`"zstd"`, `"snappy"`, `"uncompressed"`).
- **`row_group_size`** (`int`, optional): Target rows per Parquet row group.
- **`storage_options`** (`dict`, optional): S3 endpoint or authentication options.

#### Example
```python
>>> import workhouse
>>> df = workhouse.from_dict({"a": [1, 2, 3]})
>>> df.write_parquet("data/output.parquet")
```

---

### `DataFrame.write_csv`

Writes the DataFrame to a CSV file.

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
