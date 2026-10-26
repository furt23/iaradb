---
title: S3 & Cloudflare R2 Integration
description: Querying and writing to cloud object storage.
---

Iara scans and writes datasets directly on Amazon S3 and on S3-compatible object stores such as Cloudflare R2 and MinIO.

```python
import iara
from iara import functions as F
```

### How it works

Any path that names a file, a folder or a glob can be an `s3://` URL: `scan_parquet`, `read_csv`, `write_parquet`, the `register_*` methods, workspace tables and SQL `read_parquet('s3://...')`. The engine keeps one client per bucket and option set for the whole process, and counts the requests each one makes. A Parquet file is read in ranges: first its footer, then the column chunks of the row groups the query needs. Ranges that are close together share a request, and upcoming row groups are fetched in the background while the workers decode the current ones (see [Request Cost & Latency Optimization](/storage/optimization/)).

Options for a client are merged in this order, each one overriding the next: the options given in the call, the options set for the longest matching prefix with `set_storage_options`, and the environment. Credentials come from the environment, or from the instance metadata service on EC2. Requests that fail with a temporary error are retried up to five times, within 60 seconds.

Writes are multipart uploads in 16 MB parts, with up to four parts in flight. An object appears only when its upload completes. A write that fails leaves nothing behind.

---

### Authentication

Credentials are automatically read from standard environment variables:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION` or `AWS_DEFAULT_REGION`
- Alternatively, EC2 instance profiles and IMDSv2 roles are detected automatically.

Options given as storage options (`access_key_id`, `secret_access_key`, `session_token`, and the others below) take precedence over these variables.

---

### Configuring Storage Options

Storage options can be passed per scan or set globally for all URLs matching a prefix:

```python
# Set default credentials or endpoint for a bucket prefix
iara.set_storage_options("s3://analytics-bucket", {
    "region": "us-east-1"
})
```

`set_storage_options(prefix, options)` sets defaults for every URL under `prefix`. When several prefixes match, the longest one applies. Options passed in a call are merged over them, key by key. `set_storage_options(prefix, None)` removes the defaults of that prefix.

### Cloudflare R2

R2 provides an S3-compatible API. Configure it by specifying your account endpoint:

```python
iara.set_storage_options("s3://my-r2-bucket", {
    "endpoint": "https://<account_id>.r2.cloudflarestorage.com",
    "region": "auto",
})
```

---

### Scanning & Writing Over S3

```python
# Lazily scan from S3
lf = iara.scan_parquet("s3://analytics-bucket/logs/**/*.parquet")

# Stream filtered results back to S3 as a multipart upload
lf.filter(F.col("status") >= 500).sink_parquet("s3://analytics-bucket/errors/")
```

Each S3 write is a multipart upload in 16 MB parts, with up to four parts in flight. The object appears only when the upload completes. If the write fails, the upload is aborted. A local write works the same way: it goes to a temporary file that is renamed into place when the write completes.
