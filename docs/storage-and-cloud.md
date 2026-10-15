# Storage and cloud

Reading and writing S3-compatible object stores, and running Studio kernels on AWS machines.

## Object stores

Any path can be an `s3://` URL: `scan_parquet`, `scan_csv`, `scan_json`, `write_parquet`, `sink_parquet`, SQL file functions and workspace tables.

Credentials come from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and `AWS_REGION`, or from the EC2 instance profile. Other settings are storage options, passed per call or set once for a URL prefix.

```python
import workhouse

lf = workhouse.scan_parquet("s3://my-bucket/tpch/lineitem/**/*.parquet")

# options for one call
lf = workhouse.scan_parquet("s3://my-bucket/events/", storage_options={"region": "us-east-1"})

# options for every URL under a prefix
workhouse.set_storage_options("s3://my-bucket", {"region": "us-east-1"})

# register a table in a session; lazy=True lists the files on first use
ctx = workhouse.SessionContext()
ctx.register_parquet("events", "s3://my-bucket/events/", lazy=True)

# write
lf.sink_parquet("s3://my-bucket/output/summary.parquet")      # while the query runs
lf.collect().write_parquet("s3://my-bucket/output/copy.parquet")
```

Common options: `region`, `endpoint`, `allow_http`, `skip_signature` (public buckets), `access_key_id`, `secret_access_key`, `session_token`. `workhouse.list_files(pattern)` returns `[(url, size), ...]`. After changing credentials, call `workhouse.storage.clear_object_stores()`.

### R2, MinIO and other S3-compatible stores

Set `endpoint`. For R2 also set `region` to `auto`.

```python
workhouse.set_storage_options(
    "s3://my-bucket",
    {"endpoint": "https://<account_id>.r2.cloudflarestorage.com", "region": "auto"},
)
```

The same options can go in the workspace's `workhouse.toml`. Put credentials in the environment, not in this file.

```toml
[storage."s3://my-bucket"]
endpoint = "https://<account_id>.r2.cloudflarestorage.com"
region = "auto"
```

Do not set `AWS_ENDPOINT_URL` for this: it applies to every bucket.

### Request counts

Object stores charge per request, and LIST is the most expensive. To keep the count low, the engine caches directory listings for 30 seconds (and drops them when the process writes), caches Parquet footers, merges nearby byte ranges into one GET, and prefetches upcoming row groups. For Hive-partitioned tables it only reads the footers of files that pass the partition filters.

To see what was requested:

```python
before = workhouse.storage_requests()   # {"list": ..., "head": ..., "get": ..., "bytes": ...}
lf.collect()
after = workhouse.storage_requests()

result = lf.analyze()
result["requests"]               # the requests this query made
```

`storage_requests()` totals the process, so take the difference of two calls. `analyze()` runs the query once for measurement and returns `{plan, profile, rows, requests}`.

### Settings

| Variable | Default | Effect |
|---|---|---|
| `WORKHOUSE_IO_THREADS` | `4` | Threads of the I/O runtime. |
| `WORKHOUSE_REMOTE_PREFETCH` | `16` | Row groups or CSV chunks fetched ahead, in parallel. |
| `WORKHOUSE_REMOTE_PREFETCH_MB` | `256` | Memory for data fetched but not yet decoded. |
| `WORKHOUSE_COALESCE_KB` | `1024` | Ranges closer than this are fetched as one request. |
| `WORKHOUSE_MAX_REQUEST_MB` | `64` | Largest single range request. |
| `WORKHOUSE_FETCH_TARGET_MB` | `32` | Row group data fetched per request batch. |
| `WORKHOUSE_FOOTER_GUESS_KB` | `512` | Bytes read from the end of a Parquet file to get its footer in one request. |
| `WORKHOUSE_METADATA_CACHE_MB` | `256` | Cache of decoded Parquet footers. `0` turns it off. |
| `WORKHOUSE_LIST_CACHE_SECS` | `30` | How long directory listings are kept. `0` turns it off. |

## Clusters on AWS

Studio can start EC2 machines and run notebook kernels on them. Create a cluster in the Compute section: instance type (default `m7i-flex.large`), disk size (default 40 GB) and idle timeout (default 15 minutes). A cluster stops itself after the idle timeout. Notebooks attach to a cluster from the toolbar; a Local entry runs kernels on the Studio host.

### Credentials

Studio reads `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (and optionally `AWS_SESSION_TOKEN`) from the environment, or from a dotenv file named by `WORKHOUSE_AWS_ENV_FILE`. The region is `WORKHOUSE_AWS_REGION`, then `AWS_REGION`, then `us-east-1`.

### What Studio creates

- An S3 bucket for engine builds and an instance role that can read the workspace buckets.
- A security group that allows SSH only from the Studio server (`WORKHOUSE_STUDIO_CIDRS`, or the server's public IP).
- Amazon Linux 2023 instances with an encrypted EBS volume, IMDSv2 required.
- An SSH key pair, stored under `WORKHOUSE_STUDIO_DATA` (default `~/.workhouse/studio`).

Set `WORKHOUSE_TEAM` (lowercase letters, digits and hyphens, up to 31 characters) when several Studios share one AWS account. The security group becomes `workhouse-clusters-<team>`, the role and instance profile `workhouse-cluster-<team>`, and everything created for the team is tagged `workhouse:team=<team>`. Each team's role can then read only that team's workspace buckets. Without it, the names have no suffix. The engine bucket is shared.

Every signed-in member can create, clone, start and terminate clusters and run jobs on them. Only a cluster's creator or a team admin (`WORKHOUSE_ADMIN_EMAILS`) can edit or delete it; clusters created before owners were recorded are admin-only.

### Publishing the engine

Machines install the engine from the S3 bucket. Build a Linux wheel (x86-64-v3, cross-compiled with zig) and upload it:

```bash
uv pip install ziglang maturin
python -m workhouse.cloud publish
```

Other commands:

```bash
python -m workhouse.cloud verify            # list Workhouse resources left in the account
python -m workhouse.cloud cleanup --yes     # terminate cluster machines and delete the resources
```

These need AWS credentials in the environment. All three take `--region` (default `us-east-1`); `publish` also takes `--wheel PATH` to upload an existing wheel. `verify` and `cleanup` take `--team ID` (or read `WORKHOUSE_TEAM`) to cover only that team's resources, never the shared engine bucket; without it they cover every team.

### Settings

| Variable | Default | Effect |
|---|---|---|
| `WORKHOUSE_AWS_ENV_FILE` | | Dotenv file with AWS credentials. |
| `WORKHOUSE_AWS_REGION` | `us-east-1` | Region for clusters. |
| `WORKHOUSE_TEAM` | | Team id that suffixes the names of the AWS resources and tags them. |
| `WORKHOUSE_STUDIO_CIDRS` | server's public IP | CIDRs allowed to SSH to cluster machines. |
| `WORKHOUSE_STUDIO_DATA` | `~/.workhouse/studio` | Where Studio keeps its SSH key and cluster records. |
