---
title: Request Cost & Latency Optimization
description: Minimizing cloud object store requests and latency.
---

Object stores charge per API operation (LIST is the most expensive). Iara includes several optimization layers to minimize HTTP roundtrips and costs.

### How it works

A query makes three kinds of requests: listings of the directories it reads, the footers of its Parquet files, and the byte ranges of the column chunks it needs. Listings and footers are cached for the process, so a repeated query over the same files only reads data. Byte ranges that are close together share one request, and the row groups of one file are fetched in groups. The fetching runs on a separate I/O runtime of a few threads, which keep many requests in flight while the workers decode what has already arrived.

Fetched data is held under a budget (`IARA_REMOTE_PREFETCH_MB`). Each group keeps its share until the worker that decodes it is done, so prefetching cannot grow past the budget.

---

### Key Optimizations

1. **Range Coalescing**: Byte ranges of one object that lie at most `IARA_COALESCE_KB` (default 1,024 KB) apart are fetched with one `GET`, up to `IARA_MAX_REQUEST_MB` (default 64 MB) per request. The bytes between them are read too, so a little more data is fetched to save a round trip.
2. **Metadata Caching**: Decoded Parquet file footers are cached per version in memory (`IARA_METADATA_CACHE_MB`, default 256 MB), keyed by the object's version, so a replaced file is read again. The first read of a file fetches its last `IARA_FOOTER_GUESS_KB` (default 512 KB), which is the whole file when it is that small.
3. **Directory Listing Cache**: S3 prefix listings are cached for 30 seconds (`IARA_LIST_CACHE_SECS`) and dropped as soon as this process writes or deletes under the same path. Writes by other programs show up when the entry expires.
4. **Prefetch Window**: S3 readers prefetch upcoming row groups asynchronously into a bounded buffer (`IARA_REMOTE_PREFETCH_MB`, default 256 MB), keeping CPU threads busy. Up to `IARA_REMOTE_PREFETCH` (default 16) groups are fetched ahead.
5. **Delta Tables of Many Files**: A query on a Delta table is planned from the table's log alone. Filters skip files by the log's statistics, and row counts, `min` and `max` come from them. The scan opens each file it keeps when it reads it, requesting the footers of up to `IARA_REMOTE_FILES` (default 128) files at once. A file larger than `IARA_SPLIT_MB` (default 128 MB) is read as several morsels.

---

### Storage Telemetry

Inspect the storage requests this process has made. Local files are not counted, and `storage_requests()` counts every query of the process, so take the difference of two calls to cost a block of code. The figures in the examples are illustrative, from a session that read S3, and were not produced by a run here:

```python
>>> iara.storage_requests()
{'list': 1, 'head': 0, 'get': 12, 'bytes': 35651584}
```

Or inspect an individual query's share via profiling:

```python
>>> df, prof = lf.profile()
>>> prof["requests"]
{'list': 0, 'head': 0, 'get': 4, 'bytes': 12582912}
```

`lf.analyze()` returns the same counts in its `requests` field.
