---
title: S3 & Cloudflare R2 Integration
description: Querying and writing to cloud object storage.
---

Workhouse seamlessly scans and writes datasets directly to Amazon S3 and S3-compatible object storage APIs such as Cloudflare R2 and MinIO.

```python
import workhouse
from workhouse import functions as F
```

---

### Authentication

Credentials are automatically read from standard environment variables:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION` or `AWS_DEFAULT_REGION`
- Alternatively, EC2 instance profiles and IMDSv2 roles are detected automatically.

---

### Configuring Storage Options

Storage options can be passed per scan or set globally for all URLs matching a prefix:

```python
# Set default credentials or endpoint for a bucket prefix
workhouse.set_storage_options("s3://analytics-bucket", {
    "region": "us-east-1"
})
```

### Cloudflare R2 (Zero Egress)

Cloudflare R2 provides an S3-compatible API with zero egress bandwidth charges. Configure R2 by specifying your account endpoint:

```python
workhouse.set_storage_options("s3://my-r2-bucket", {
    "endpoint": "https://<account_id>.r2.cloudflarestorage.com",
    "region": "auto",
})
```

---

### Scanning & Writing Over S3

```python
# Lazily scan from S3
lf = workhouse.scan_parquet("s3://analytics-bucket/logs/**/*.parquet")

# Stream filtered results back to S3 using multipart uploads
lf.filter(F.col("status") >= 500).sink_parquet("s3://analytics-bucket/errors/")
```
