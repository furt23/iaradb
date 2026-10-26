---
title: Engine Control & Configuration
description: Functions for tuning concurrency, memory limits, and query lifecycle.
---

## How it works

The engine keeps some state for the whole process, and the functions on this page read or change it: the worker thread pool, the memory pool, the registry of running queries, and the storage defaults and request counters. All queries in the process share this state.

Operators that hold state across batches reserve their memory from the process-wide memory pool: aggregation tables, join build sides, sort buffers, and window partitions. When a reservation would go over the limit, the operator writes its state to spill files (in the temporary directory, or in the folder named by `IARA_SPILL_DIR`) and carries on. Batches in flight are not counted, so `peak` can be higher than the limit. Without an explicit limit, the default is three quarters of the machine's RAM, fitted at the start of each query to the memory that is free then, and never below half of that default. The environment variable `IARA_MEMORY_LIMIT` sets the starting value, using the same forms as `set_memory_limit`.

Each `collect`, `stream` or sink is a query with an id. `running_queries()` lists the queries in progress, `interrupt()` and `cancel_query()` cancel them. A cancelled query stops at the next morsel boundary and raises `QueryCancelled`, a subclass of `IaraError`.

---

### `iara.set_num_threads`

Sets the number of worker threads in the background Rayon thread pool. Must be called before executing the first query.

```python
iara.set_num_threads(n: int) -> None
```

The pool is built once for the process. The call succeeds only before the first query runs; after that it raises `IaraError` ("thread pool already initialised").

#### Example
```python
>>> import iara
>>> iara.set_num_threads(8)
>>> iara.num_threads()
8
```

---

### `iara.num_threads`

Returns the number of active worker threads allocated to query execution.

```python
iara.num_threads() -> int
```

The morsels of every operator (scans, aggregations, joins, sorts) are processed on these threads.

---

### `iara.set_memory_limit`

Sets the process memory limit for execution operators (joins, aggregations, sorts, window frames). Beyond this threshold, operators spill intermediate state to disk.

```python
iara.set_memory_limit(limit: str | int | None = None) -> None
```

The limit applies to reservations made from the call onward. Memory that is already held stays where it is. Passing `None` removes the limit. All queries in the process share one limit, so concurrent queries draw on the same budget.

#### Parameters
- **`limit`** (`str | int | None`): Byte count (`1073741824`), human-readable string (`"4GB"`, `"512MB"`), or memory percentage (`"60%"`). `None` means no limit.

#### Notes
- Strings take units `KB`, `MB`, `GB` and `TB`, with or without the `i` and `B` (`"1.5GiB"`, `"512 MB"`). The units are powers of 1024. A percentage is taken of the machine's RAM.
- An integer is a number of bytes. A value of another type, or an unreadable string, raises `ValueError`.

#### Example
```python
>>> iara.set_memory_limit("4GB")
```

---

### `iara.memory_usage`

Returns current memory metrics of the global engine pool.

```python
iara.memory_usage() -> dict[str, int | None]
```

`used` is the number of bytes that operators hold now. `peak` is the highest value of `used` since the pool was last reset, and the pool is reset when a query starts while no other query runs. `spilled` is the number of bytes written to spill files by the process so far; it only grows. `limit` is `None` when there is no limit.

#### Returns
- **`dict`**: Contains `limit`, `used`, `peak`, and `spilled` byte counts.

#### Example
```python
>>> iara.set_memory_limit("4GB")
>>> iara.memory_usage()
{'limit': 4294967296, 'used': 0, 'peak': 0, 'spilled': 0}
```

---

### `iara.running_queries`

Lists all query handles currently active in the execution registry.

```python
iara.running_queries() -> list[dict[str, Any]]
```

Each entry describes one query in progress: `id` (an integer, for `cancel_query`), `elapsed_ms`, `cancelled`, `memory_peak`, `spilled_bytes`, `requests` (the object store requests the query has made so far), `pipelines` (one dict per pipeline, with `source`, `operators`, `sink`, `morsels_total`, `morsels_done`, `rows_in`, `rows_out`, `elapsed_ms` and `finished`), and `pending` (the pipelines planned but not started). The list is empty when no query runs.

#### Example
```python
>>> iara.running_queries()  # no query in progress
[]
```

---

### `iara.interrupt` / `iara.cancel_query`

Cancels queries in progress. Workers abort processing at the next morsel boundary.

```python
iara.interrupt() -> int
iara.cancel_query(query_id: int) -> bool
```

`interrupt()` cancels every query running in the process and returns how many there were. `cancel_query()` cancels the query with the given `id` from `running_queries()`, and returns `False` when no such query is running. A cancelled query raises `QueryCancelled` where it is collected or written.

#### Example
```python
>>> iara.interrupt()
0
>>> iara.cancel_query(12345)
False
```

---

### `iara.set_storage_options`

Registers default storage options (such as endpoint URL, AWS region, or S3 credentials) for all URLs under a bucket or prefix.

```python
iara.set_storage_options(prefix: str, options: dict[str, Any] | None = None) -> None
```

The defaults apply to every URL under `prefix` (`s3://bucket`, or `s3://bucket/some/prefix`). When several prefixes match a URL, the longest one applies. Options given with a scan or sink (`storage_options`) override the defaults key by key. Passing `None` or `{}` removes the defaults of that prefix. The defaults last for the life of the process.

#### Example
```python
>>> iara.set_storage_options("s3://warehouse", {
...     "endpoint": "https://account.r2.cloudflarestorage.com",
...     "region": "auto",
... })
```

---

### `iara.storage_requests`

Returns cumulative counts of all object store API requests executed across the process lifetime.

```python
iara.storage_requests() -> dict[str, int]
```

The keys are `list` (LIST requests), `head` (HEAD requests), `get` (GET requests), and `bytes` (the bytes that the GET requests asked for). The counts only grow, so the difference between two readings costs the work between them. Local files are not counted.

#### Example
```python
>>> iara.storage_requests()
{'list': 0, 'head': 0, 'get': 0, 'bytes': 0}
```

---

### `iara.list_files`

Lists all files matching an object storage prefix or glob pattern.

```python
iara.list_files(pattern: str, extension: str = "parquet", storage_options: dict[str, Any] | None = None) -> list[tuple[str, int]]
```

Expands a path, folder, glob pattern or URL into its data files, the same way the scanners do, and returns `(path, size_in_bytes)` pairs in sorted order. A folder is searched recursively for files with `extension`. For a URL, the listing is a LIST request (see `storage_requests`).

#### Parameters
- **`pattern`** (`str`): A local path, folder, or glob pattern, or an `s3://` URL.
- **`extension`** (`str`, default `"parquet"`): The extension of the files to take from a folder.
- **`storage_options`** (`dict`, optional): Object store settings for a URL.

#### Example
```python
>>> iara.list_files("data/*.parquet")
[('data\\small.parquet', 797), ('data\\users.parquet', 992)]
```
