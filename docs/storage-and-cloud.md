# Storage & Cloud Infrastructure

Workhouse provides native integrations with cloud object stores (Amazon S3 and Cloudflare R2) and automates on-demand compute cluster provisioning in AWS.

---

## Object Store Integration

Paths in Workhouse can point directly to object store URLs (`s3://...`). Authentication is handled automatically via environment credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), an EC2 instance profile, or workspace environment files.

```python
import workhouse as wh

# Scan Parquet directly from S3
df = wh.scan_parquet("s3://my-bucket/tpch/lineitem/**/*.parquet")

# Set default storage options for all URLs under a bucket prefix
wh.set_storage_options("s3://my-bucket", {"region": "us-east-1"})

# Register in SessionContext with custom endpoint options
ctx = wh.SessionContext()
ctx.register_parquet("events", "s3://my-bucket/events/", storage_options={"endpoint": "http://localhost:9000"}, lazy=True)

# Write results directly back to S3 via multipart upload
df.collect().write_parquet("s3://my-bucket/output/summary.parquet")
```

### Cloudflare R2
Cloudflare R2 is fully S3-compatible and provides zero-egress data transfer. Configure R2 by setting the custom account endpoint:

In Python:
```python
wh.set_storage_options(
    "s3://my-bucket",
    {
        "endpoint": "https://<account_id>.r2.cloudflarestorage.com",
        "region": "auto",
    }
)
```

Or in `workhouse.toml`:
```toml
[storage."s3://my-bucket"]
endpoint = "https://<account_id>.r2.cloudflarestorage.com"
region = "auto"
```

> **Note**: Store credentials in the environment (`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`). Avoid setting `AWS_ENDPOINT_URL` globally in the environment, as it applies globally to every bucket.

---

## Request Cost & Latency Optimization

Cloud storage providers bill per API request (LIST and PUT operations being the most expensive). Workhouse incorporates specialized caching, coalescing, and prefetching layers to minimize API roundtrips and cost:

1. **Listing Cache**: Directory listings are cached for 30 seconds by default and invalidated immediately whenever the process writes.
2. **Parquet Footer Cache**: Footers are cached per file version for the lifetime of the process. Files up to 512 KB are fetched entirely in a single read.
3. **Range Coalescing**: Adjacent or nearby byte ranges (within 1,024 KB) are merged into a single `GET` request.
4. **Prefetch Window**: Scans fetch upcoming row groups asynchronously into a bounded memory buffer, keeping network transfers saturated while compute threads process batches.
5. **Partition-Selective Footers**: Hive-partitioned tables read only footers for files that satisfy partition predicate filters.

### Telemetry & Monitoring
Track storage API requests in Python:
```python
# Process totals
wh.storage_requests()
# -> {"list": 1, "head": 0, "get": 14, "bytes": 45088768}

# Inspect individual query share
plan_profile = lf.profile()
print(plan_profile["requests"])
```

### Storage Configuration Variables

| Variable | Default | Purpose |
|---|---|---|
| `WORKHOUSE_COALESCE_KB` | `1024` | Byte distance threshold for merging nearby ranges into a single GET request. |
| `WORKHOUSE_MAX_REQUEST_MB` | `64` | Maximum byte size of any single range request. |
| `WORKHOUSE_FETCH_TARGET_MB` | `32` | Target cumulative size of row groups fetched per request batch. |
| `WORKHOUSE_FOOTER_GUESS_KB` | `512` | Initial read size from the end of a Parquet file to capture metadata. |
| `WORKHOUSE_METADATA_CACHE_MB`| `256` | Maximum memory allocated to cache decoded Parquet file footers (`0` disables). |
| `WORKHOUSE_LIST_CACHE_SECS` | `30` | Duration to retain directory listing results (`0` disables). |
| `WORKHOUSE_IO_THREADS` | `4` | Worker threads allocated to the background I/O tokio runtime. |
| `WORKHOUSE_REMOTE_PREFETCH` | `16` | Number of upcoming row groups or CSV chunks prefetched in parallel. |
| `WORKHOUSE_REMOTE_PREFETCH_MB`| `256` | Maximum in-flight buffer memory for prefetched raw data. |

---

## AWS On-Demand Clusters

Workhouse Studio can deploy ephemeral compute environments on AWS EC2 to scale execution out from local hardware.

### Lifecycle & Security Architecture
- **Isolated Credentials**: The Studio server creates clusters using credentials configured via `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, or an env file specified by `WORKHOUSE_AWS_ENV_FILE`.
- **Dynamic Security Groups**: On first initialization, Studio constructs an EC2 Security Group permitting SSH ingress exclusively from the Studio server (`WORKHOUSE_STUDIO_CIDRS` or the server's public IP).
- **Least-Privilege Roles**: An EC2 Instance Role is provisioned with access restricted to workspace S3 buckets and engine artifact storage.
- **Hardened Instances**: Instances boot Amazon Linux 2023 with EBS volume encryption and IMDSv2 enforced.
- **Dedicated Key Management**: The Studio connects via internal SSH keys stored in `WORKHOUSE_STUDIO_DATA` (default: `~/.workhouse/studio`), without requiring existing EC2 key pairs.
- **Auto-Termination**: Instances automatically power off after the configured idle period, eliminating unnecessary cloud spend.

### Engine Publishing & Management
Compute clusters pull engine releases from a private S3 artifacts bucket. You can cross-compile and publish a Linux x86-64-v3 release using Zig:

```bash
# Install cross-compilation toolchain
uv pip install ziglang maturin

# Build and upload the engine wheel to S3 for cluster instances
uv run --env-file .aws python -m workhouse.cloud publish

# Audit your AWS account for running Workhouse resources
uv run --env-file .aws python -m workhouse.cloud verify

# Clean up all running cluster instances and shared cloud resources
uv run --env-file .aws python -m workhouse.cloud cleanup --yes
```
