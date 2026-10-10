---
title: Top-Level Module Functions
description: Global functions exposed directly by the workhouse module.
---

The `workhouse` root package provides entry-point constructors, file scanners, SQL query runners, and engine configuration functions.

```python
import workhouse as wh
```

## Function Summary

### I/O & Constructors
| Function | Description |
|---|---|
| [`wh.scan_parquet(path, ...)`][io] | Lazily scans a Parquet file, directory, or glob pattern. |
| [`wh.scan_csv(path, ...)`][io] | Lazily scans a CSV file or directory. |
| [`wh.read_parquet(path, ...)`][io] | Eagerly reads Parquet files into a materialized `DataFrame`. |
| [`wh.read_csv(path, ...)`][io] | Eagerly reads CSV files into a materialized `DataFrame`. |
| [`wh.from_arrow(data)`][io] | Imports data from any Arrow C Stream compatible object. |
| [`wh.from_pandas(df)`][io] | Constructs a `DataFrame` from a Pandas DataFrame. |
| [`wh.from_polars(df)`][io] | Constructs a `DataFrame` from a Polars DataFrame. |
| [`wh.from_dict(data)`][io] | Constructs a `DataFrame` from a dictionary of column sequences. |
| [`wh.sql(query, **tables)`][io] | Runs an ANSI SQL query against provided DataFrames or LazyFrames. |
| [`wh.workspace(path=None)`][io] | Connects to a `workhouse.toml` workspace catalog. |

### Engine & System Control
| Function | Description |
|---|---|
| [`wh.set_num_threads(n)`][engine] | Sets the worker thread pool size before query execution. |
| [`wh.num_threads()`][engine] | Retrieves the current number of execution worker threads. |
| [`wh.set_memory_limit(limit)`][engine] | Sets the maximum memory threshold before out-of-core disk spilling occurs. |
| [`wh.memory_usage()`][engine] | Returns current memory pool allocation, peak, and spill statistics. |
| [`wh.running_queries()`][engine] | Lists IDs and runtime details of queries actively in progress. |
| [`wh.interrupt(query_id)`][engine] | Interrupts and cancels a running query by ID. |
| [`wh.set_storage_options(prefix, options)`][engine] | Sets default S3/R2 storage settings for a bucket or URL prefix. |
| [`wh.storage_requests()`][engine] | Returns cumulative object store request counts (`list`, `head`, `get`, `bytes`). |

[io]: /top-level/io/
[engine]: /top-level/engine/
