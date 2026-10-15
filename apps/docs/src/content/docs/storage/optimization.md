---
title: Request Cost & Latency Optimization
description: Minimizing cloud object store requests and latency.
---

Object stores charge per API operation (LIST and PUT operations are the most expensive). Workhouse includes several optimization layers to minimize HTTP roundtrips and costs.

---

### Key Optimizations

1. **Range Coalescing**: Consecutive byte range reads located within `WORKHOUSE_COALESCE_KB` (default 1,024 KB) are merged into a single `GET` request.
2. **Metadata Caching**: Decoded Parquet file footers are cached per version in memory (`WORKHOUSE_METADATA_CACHE_MB`, default 256 MB).
3. **Directory Listing Cache**: S3 prefix listings are cached for 30 seconds (`WORKHOUSE_LIST_CACHE_SECS`) and invalidated immediately upon write.
4. **Prefetch Window**: S3 readers prefetch upcoming row groups asynchronously into a bounded buffer (`WORKHOUSE_REMOTE_PREFETCH_MB`, default 256 MB), keeping CPU threads saturated.

---

### Storage Telemetry

Inspect cumulative storage API usage across your session:

```python
>>> workhouse.storage_requests()
{'list': 1, 'head': 0, 'get': 12, 'bytes': 35651584}
```

Or inspect an individual query's share via profiling:

```python
>>> df, prof = lf.profile()
>>> prof["requests"]
{'list': 0, 'head': 0, 'get': 4, 'bytes': 12582912}
```
