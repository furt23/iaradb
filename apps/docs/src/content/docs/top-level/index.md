---
title: Top-Level Module Functions
description: Global functions exposed directly by the workhouse module.
---

The `workhouse` root package provides entry-point constructors, file scanners, SQL query runners, and engine configuration functions. Expression functions (`col`, `lit`, `when`, aggregates) are in `workhouse.functions`, imported as `F` in these docs: see [Column Expressions](/expressions/).

```python
import workhouse
```

## Function Summary

### I/O & Constructors
| Function | Description |
|---|---|
| [`workhouse.scan_parquet(path, ...)`][io] | Lazily scans a Parquet file, directory, or glob pattern. |
| [`workhouse.scan_csv(path, ...)`][io] | Lazily scans a CSV file or directory. |
| [`workhouse.read_parquet(path, ...)`][io] | Eagerly reads Parquet files into a materialized `DataFrame`. |
| [`workhouse.read_csv(path, ...)`][io] | Eagerly reads CSV files into a materialized `DataFrame`. |
| [`workhouse.from_arrow(data)`][io] | Imports data from any Arrow C Stream compatible object. |
| [`workhouse.from_pandas(df)`][io] | Constructs a `DataFrame` from a Pandas DataFrame. |
| [`workhouse.from_polars(df)`][io] | Constructs a `DataFrame` from a Polars DataFrame. |
| [`workhouse.from_dict(data)`][io] | Constructs a `DataFrame` from a dictionary of column sequences. |
| [`workhouse.sql(query, **tables)`][io] | Runs an ANSI SQL query against provided DataFrames or LazyFrames. |
| [`workhouse.workspace(path=None)`][io] | Connects to a `workhouse.toml` workspace catalog. |
| `workhouse.preview(frame, n=500)` | Shows the first `n` rows (in a Studio notebook, as the cell's table); also `frame.preview()`. |

### Engine & System Control
| Function | Description |
|---|---|
| [`workhouse.set_num_threads(n)`][engine] | Sets the worker thread pool size before query execution. |
| [`workhouse.num_threads()`][engine] | Retrieves the current number of execution worker threads. |
| [`workhouse.set_memory_limit(limit)`][engine] | Sets the maximum memory threshold before out-of-core disk spilling occurs. |
| [`workhouse.memory_usage()`][engine] | Returns current memory pool allocation, peak, and spill statistics. |
| [`workhouse.running_queries()`][engine] | Lists IDs and runtime details of queries actively in progress. |
| [`workhouse.interrupt(query_id)`][engine] | Interrupts and cancels a running query by ID. |
| [`workhouse.set_storage_options(prefix, options)`][engine] | Sets default S3/R2 storage settings for a bucket or URL prefix. |
| [`workhouse.storage_requests()`][engine] | Returns cumulative object store request counts (`list`, `head`, `get`, `bytes`). |

[io]: /top-level/io/
[engine]: /top-level/engine/
