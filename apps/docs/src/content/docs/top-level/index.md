---
title: Top-Level Module Functions
description: Global functions exposed directly by the iara module.
---

The `iara` root package provides entry-point constructors, file scanners, SQL query runners, and engine configuration functions. Expression functions (`col`, `lit`, `when`, aggregates) are in `iara.functions`, imported as `F` in these docs: see [Column Expressions](/expressions/).

```python
import iara
```

## Function Summary

### I/O & Constructors
| Function | Description |
|---|---|
| [`iara.scan_parquet(path, ...)`][io] | Lazily scans a Parquet file, directory, or glob pattern. |
| [`iara.scan_csv(path, ...)`][io] | Lazily scans a CSV file or directory. |
| [`iara.read_parquet(path, ...)`][io] | Eagerly reads Parquet files into a materialized `DataFrame`. |
| [`iara.read_csv(path, ...)`][io] | Eagerly reads CSV files into a materialized `DataFrame`. |
| [`iara.from_arrow(data)`][io] | Imports data from any Arrow C Stream compatible object. |
| [`iara.from_pandas(df)`][io] | Constructs a `DataFrame` from a Pandas DataFrame. |
| [`iara.from_polars(df)`][io] | Constructs a `DataFrame` from a Polars DataFrame. |
| [`iara.from_dict(data)`][io] | Constructs a `DataFrame` from a dictionary of column sequences. |
| [`iara.sql(query, **tables)`][io] | Runs an ANSI SQL query against provided DataFrames or LazyFrames. |
| [`iara.workspace(path=None)`][io] | Connects to a `iara.toml` workspace catalog. |
| `iara.preview(frame, n=500)` | Shows the first `n` rows (in a Studio notebook, as the cell's table); also `frame.preview()`. |

### Engine & System Control
| Function | Description |
|---|---|
| [`iara.set_num_threads(n)`][engine] | Sets the worker thread pool size before query execution. |
| [`iara.num_threads()`][engine] | Retrieves the current number of execution worker threads. |
| [`iara.set_memory_limit(limit)`][engine] | Sets the maximum memory threshold before out-of-core disk spilling occurs. |
| [`iara.memory_usage()`][engine] | Returns current memory pool allocation, peak, and spill statistics. |
| [`iara.running_queries()`][engine] | Lists IDs and runtime details of queries actively in progress. |
| [`iara.interrupt(query_id)`][engine] | Interrupts and cancels a running query by ID. |
| [`iara.set_storage_options(prefix, options)`][engine] | Sets default S3/R2 storage settings for a bucket or URL prefix. |
| [`iara.storage_requests()`][engine] | Returns cumulative object store request counts (`list`, `head`, `get`, `bytes`). |

[io]: /top-level/io/
[engine]: /top-level/engine/
