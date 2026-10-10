---
title: Engine Control & Configuration
description: Functions for tuning concurrency, memory limits, and query lifecycle.
---

### `wh.set_num_threads`

Sets the number of worker threads in the background Rayon thread pool. Must be called before executing the first query.

```python
wh.set_num_threads(n: int) -> None
```

#### Example
```python
>>> import workhouse as wh
>>> wh.set_num_threads(8)
>>> wh.num_threads()
8
```

---

### `wh.num_threads`

Returns the number of active worker threads allocated to query execution.

```python
wh.num_threads() -> int
```

---

### `wh.set_memory_limit`

Sets the process memory limit for execution operators (joins, aggregations, sorts, window frames). Beyond this threshold, operators spill intermediate state to disk.

```python
wh.set_memory_limit(limit: str | int) -> None
```

#### Parameters
- **`limit`** (`str | int`): Byte count (`1073741824`), human-readable string (`"4GB"`, `"512MB"`), or memory percentage (`"60%"`).

#### Example
```python
>>> wh.set_memory_limit("4GB")
```

---

### `wh.memory_usage`

Returns current memory metrics of the global engine pool.

```python
wh.memory_usage() -> dict[str, int | None]
```

#### Returns
- **`dict`**: Contains `limit`, `used`, `peak`, and `spilled` byte counts.

#### Example
```python
>>> wh.memory_usage()
{'limit': 4294967296, 'used': 1048576, 'peak': 32440320, 'spilled': 0}
```

---

### `wh.running_queries`

Lists all query handles currently active in the execution registry.

```python
wh.running_queries() -> list[dict[str, Any]]
```

#### Example
```python
>>> wh.running_queries()
[{'id': 'q_98ac12', 'elapsed_ms': 120, 'rows_out': 45000}]
```

---

### `wh.interrupt` / `wh.cancel_query`

Cancels a query in progress by its unique identifier. Workers will abort processing at the next morsel boundary.

```python
wh.interrupt(query_id: str) -> bool
wh.cancel_query(query_id: str) -> bool
```

#### Example
```python
>>> wh.interrupt("q_98ac12")
True
```

---

### `wh.set_storage_options`

Registers default storage options (such as endpoint URL, AWS region, or S3 credentials) for all URLs under a bucket or prefix.

```python
wh.set_storage_options(prefix: str, options: dict[str, Any]) -> None
```

#### Example
```python
>>> wh.set_storage_options("s3://warehouse", {
...     "endpoint": "https://account.r2.cloudflarestorage.com",
...     "region": "auto",
... })
```

---

### `wh.storage_requests`

Returns cumulative counts of all object store API requests executed across the process lifetime.

```python
wh.storage_requests() -> dict[str, int]
```

#### Example
```python
>>> wh.storage_requests()
{'list': 2, 'head': 0, 'get': 18, 'bytes': 67108864}
```

---

### `wh.list_files`

Lists all files matching an object storage prefix or glob pattern.

```python
wh.list_files(path: str, storage_options: dict[str, Any] | None = None) -> list[str]
```

#### Example
```python
>>> wh.list_files("s3://bucket/logs/2026/10/")
['s3://bucket/logs/2026/10/01.parquet', 's3://bucket/logs/2026/10/02.parquet']
```
