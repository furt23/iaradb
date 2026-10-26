---
title: Top-Level Module Functions
description: Global functions exposed directly by the iara module.
---

The `iara` root package provides entry-point constructors, file scanners, SQL query runners, and engine configuration functions. Expression functions (`col`, `lit`, `when`, aggregates) are in `iara.functions`, imported as `F` in these docs: see [Column Expressions](/expressions/).

```python
import iara
```

## How it works

The functions fall into two groups. Sources (`scan_*`, `sql`, `workspace`) describe data without reading it. `scan_*` and `sql` return a `LazyFrame`, a plan that runs when it is collected or written. `read_*` and `from_*` return a `DataFrame` already held in memory: `read_*` is a scan followed by `collect()`, and `from_*` converts a Python or Arrow object into the engine's record batches.

The engine settings (`set_num_threads`, `set_memory_limit`, `set_storage_options`) are per process, not per frame. They apply to every query that runs afterwards in the same process. The thread count can only be set before the first query runs (see [Engine Control](/top-level/engine/)).

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
| [`iara.interrupt()`][engine] / [`iara.cancel_query(query_id)`][engine] | Cancels every running query, or one query by ID. |
| [`iara.set_storage_options(prefix, options)`][engine] | Sets default S3/R2 storage settings for a bucket or URL prefix. |
| [`iara.storage_requests()`][engine] | Returns cumulative object store request counts (`list`, `head`, `get`, `bytes`). |
| [`iara.list_files(pattern, ...)`][engine] | Lists the data files a path, folder, glob or URL expands to, with their sizes. |

[io]: /top-level/io/
[engine]: /top-level/engine/
