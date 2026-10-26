# Storage and cloud

Reading and writing S3-compatible object stores, and running Studio kernels on AWS machines.

## Object stores

Any path can be an `s3://` URL: `scan_parquet`, `scan_csv`, `scan_json`, `write_parquet`, `sink_parquet`, SQL file functions and workspace tables.

Credentials come from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and `AWS_REGION`, or from the EC2 instance profile. Other settings are storage options, passed per call or set once for a URL prefix.

```python
import iara

lf = iara.scan_parquet("s3://my-bucket/tpch/lineitem/**/*.parquet")

# options for one call
lf = iara.scan_parquet("s3://my-bucket/events/", storage_options={"region": "us-east-1"})

# options for every URL under a prefix
iara.set_storage_options("s3://my-bucket", {"region": "us-east-1"})

# register a table in a session; lazy=True lists the files on first use
ctx = iara.SessionContext()
ctx.register_parquet("events", "s3://my-bucket/events/", lazy=True)

# write
lf.sink_parquet("s3://my-bucket/output/summary.parquet")      # while the query runs
lf.collect().write_parquet("s3://my-bucket/output/copy.parquet")
```

Common options: `region`, `endpoint`, `allow_http`, `skip_signature` (public buckets), `access_key_id`, `secret_access_key`, `session_token`. `iara.list_files(pattern)` returns `[(url, size), ...]`. After changing credentials, call `iara.storage.clear_object_stores()`.

### R2, MinIO and other S3-compatible stores

Set `endpoint`. For R2 also set `region` to `auto`.

```python
iara.set_storage_options(
    "s3://my-bucket",
    {"endpoint": "https://<account_id>.r2.cloudflarestorage.com", "region": "auto"},
)
```

The same options can go in the workspace's `iara.toml` (read by the library) or in the Studio catalog (see [Studio](studio.md#catalog)). Put credentials in the environment, not in either file.

```toml
[storage."s3://my-bucket"]
endpoint = "https://<account_id>.r2.cloudflarestorage.com"
region = "auto"
```

In team mode (`IARA_BUCKET` set), Studio gives its kernels the endpoint (`IARA_STORAGE_ENDPOINT`) and region of the team bucket itself, so the catalog needs no `[storage]` section for it.

Do not set `AWS_ENDPOINT_URL` for this: it applies to every bucket.

### Request counts

Object stores charge per request, and LIST is the most expensive. To keep the count low, the engine caches directory listings for 30 seconds (and drops them when the process writes), caches Parquet footers, merges nearby byte ranges into one GET, and prefetches upcoming row groups. For Hive-partitioned tables it only reads the footers of files that pass the partition filters.

To see what was requested:

```python
before = iara.storage_requests()   # {"list": ..., "head": ..., "get": ..., "bytes": ...}
lf.collect()
after = iara.storage_requests()

result = lf.analyze()
result["requests"]               # the requests this query made
```

`storage_requests()` totals the process, so take the difference of two calls. `analyze()` runs the query once for measurement and returns `{plan, profile, rows, requests}`.

### Settings

| Variable | Default | Effect |
|---|---|---|
| `IARA_IO_THREADS` | `4` | Threads of the I/O runtime. |
| `IARA_REMOTE_PREFETCH` | `16` | Row groups or CSV chunks fetched ahead, in parallel. |
| `IARA_REMOTE_PREFETCH_MB` | `256` | Memory for data fetched but not yet decoded. |
| `IARA_COALESCE_KB` | `1024` | Ranges closer than this are fetched as one request. |
| `IARA_MAX_REQUEST_MB` | `64` | Largest single range request. |
| `IARA_FETCH_TARGET_MB` | `32` | Row group data fetched per request batch. |
| `IARA_FOOTER_GUESS_KB` | `512` | Bytes read from the end of a Parquet file to get its footer in one request. |
| `IARA_METADATA_CACHE_MB` | `256` | Cache of decoded Parquet footers. `0` turns it off. |
| `IARA_LIST_CACHE_SECS` | `30` | How long directory listings are kept. `0` turns it off. |

## Clusters on AWS

Studio can start EC2 machines and run notebook kernels on them. Create a cluster in the Compute section: instance type (default `m7i-flex.large`), disk size (default 40 GB) and idle timeout (default 15 minutes). A cluster stops itself after the idle timeout. The dialog starts the cluster right after creating it unless you untick "Start the cluster now". Notebooks attach to a cluster from the toolbar or from the cluster's Notebooks tab; a Local entry runs kernels on the Studio host, in development, under `iara serve`, or with `IARA_LOCAL_COMPUTE=1` only (a production build run otherwise, such as the Docker image, has none).

Other cluster settings:

| Setting | Default | Notes |
|---|---|---|
| Time limit | 1 h | The machine terminates after this many hours (1 to 12), idle or not. Can change while it runs. |
| Spot machine | off | Launches a spot instance. If EC2 has no spot capacity, the cluster starts on-demand and the event log says so. AWS can reclaim a spot machine at any time. |
| Libraries | none | pip requirements (`polars==1.9`, `pandas[parquet]>=2.2`) installed at boot. URLs and environment markers are not accepted. Libraries added while the cluster runs are installed right away; removed ones leave at the next start. |
| Environment variables | none | Passed to the cluster's kernels. Names starting with `IARA_` or `AWS_` are reserved. Don't put secrets here. |
| Init script | none | Bash run at boot, after the engine and libraries, with the environment variables set. It runs as the kernel user (`iara`), not as root: it cannot install system packages or change the system. Up to 8 KB. If it fails, the start fails. |
| AWS tags | none | Added to the machine and its volume. Keys starting with `aws:` or `iara:` and `Name` are reserved. |

Spot, init script, tags, machine and disk only change while the cluster is terminated.

The cluster page has a Logs tab: the machine's boot log, the init script output and the kernels' stderr. When a start fails, the last boot lines are kept until the next start.

### Credentials

Each team's Studio uses its own AWS keys, made by `team-setup` (below): `IARA_AWS_ACCESS_KEY_ID` and `IARA_AWS_SECRET_ACCESS_KEY`, else `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (and optionally `AWS_SESSION_TOKEN`) from the environment or from a dotenv file named by `IARA_AWS_ENV_FILE`. The region is `IARA_AWS_REGION`, then `AWS_REGION`, then `us-east-1`. Never give a Studio admin keys.

### Setting up a team

An administrator runs this once per team, with admin credentials:

```bash
python -m iara.cloud team-setup <team>    # prints IARA_AWS_ACCESS_KEY_ID=... and IARA_AWS_SECRET_ACCESS_KEY=...
```

It creates, or updates when run again:

- the shared engine bucket, if missing;
- the role and instance profile `iara-cluster-<team>`, which can only read the engine builds;
- the security group `iara-clusters-<team>`;
- the IAM user `iara-studio-<team>` with the policy `iara-studio-<team>`, and an access key for it (only when the user has none, or with `--new-key`).

Put the two printed lines in the team's env file. The user's policy allows launching machines tagged `iara:team=<team>` with that security group and Amazon images, passing only the team's role, terminating only machines with the team's tag, changing the SSH rules of the team's security group, and the few reads Studio needs. It cannot create IAM resources or buckets, or touch another team's machines.

`python -m iara.cloud team-remove <team> --yes` deletes them; it refuses while the team has machines that are not terminated.

### Who runs what on a cluster machine

Notebook code runs as the `iara` user. It has no sudo, and the firewall refuses its connections to the instance metadata service, so the machine's instance role is not available to it. The init script runs as `iara` too. Studio logs in over SSH as `ec2-user`, which has sudo, and starts each kernel with `sudo -u iara`.

### Team bucket access from clusters

When `IARA_BUCKET` is set, each machine runs `iara-s3-proxy`, a small program listening on `127.0.0.1:9000` as its own user (`iara-proxy`). It forwards S3 requests for the team bucket to `IARA_STORAGE_ENDPOINT` (AWS S3 in the region of `AWS_REGION` when that is empty), signing them with the bucket's keys. Kernels are started with `AWS_ENDPOINT_URL=http://127.0.0.1:9000`, `AWS_ALLOW_HTTP=true` and placeholder credentials, so they read and write the bucket through the proxy and never hold its keys. The catalog sent to a cluster kernel has no `[storage]` section for the bucket's endpoint.

The boot script installs the proxy and its systemd unit but does not start it, because the keys are not on the machine yet. Before the first kernel starts on a machine, Studio sends `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` over SSH on standard input into `/etc/iara/r2.json`, which only `iara-proxy` can read, then starts the unit. The keys are not in the user data, the environment or any command line. With `IARA_BUCKET` set and those two variables missing, kernels do not start on clusters.

Consequences:

- Kernels on a cluster reach the team bucket only. The proxy refuses other buckets, and with the instance role out of reach, other `s3://` URLs work only if the code passes its own credentials as storage options. Without `IARA_BUCKET` there is no proxy and no ambient S3 access.
- If the bucket's R2 token has client IP address filtering, the proxy's requests (from the machine's address) are refused.
- Code on a cluster can still make requests through the proxy while the machine runs, but cannot read the keys or use them after the machine is gone.

Clusters install the engine wheel and the proxy binary from the engine bucket: publish them again (below) after changing the kernel or the proxy.

### What Studio does in AWS

Studio creates nothing in IAM or S3. It finds the team's security group and instance profile by name (and fails with "AWS is not set up for team <team>" when `team-setup` was not run), sets the security group's SSH rule to the Studio server's address (`IARA_STUDIO_CIDRS`, or the server's public IP), and launches Amazon Linux 2023 instances tagged `iara:team=<team>`, with an encrypted EBS volume and IMDSv2 required. Its SSH key pair is stored under `IARA_STUDIO_DATA` (default `~/.iara/studio`).

`IARA_TEAM` is required (lowercase letters, digits and hyphens, up to 31 characters).

Every signed-in member can create, clone, start and terminate clusters and run jobs on them. Only a cluster's creator or a team admin (`IARA_ADMIN_EMAILS`) can edit or delete it; clusters created before owners were recorded are admin-only.

Viewers (`IARA_VIEWER_EMAILS`) sign in like members but only reach `/view`, where they open the published dashboards shared with them. They never see the workspace, the catalog or a dashboard's SQL. A published dashboard's queries run on its cluster, limited to the tables the viewer has a grant on ([Data permissions](studio.md#data-permissions)). Without grants, a viewer reads nothing.

`IARA_VIEW_HOST` (a bare hostname such as `view-<team>.<domain>`) serves the same Studio under a second name that has only `/view` and sign-in: every other page there redirects to `/view`, and other requests get 404. Requests on that host also cannot call the Studio's server actions or API routes, even when a member is signed in there. Add an ingress rule in `docker/cloudflared/config.yml` for the hostname that points to the same service as the Studio (no `httpHostHeader`, the Studio reads the `Host` header), list both addresses in `APP_BASE_URL` separated by a comma, and add each address's `/auth/callback` to the Auth0 application's Allowed Callback URLs and each address to its Allowed Logout URLs. Sessions are per hostname, so people sign in once on each. The editor's "Open view" link then points to the view host. If `IARA_VIEW_HOST` is set but is not a bare hostname, the Studio answers 503 until it is fixed.

### Publishing the engine

Machines install the engine from the S3 bucket. Build a Linux wheel (x86-64-v3, cross-compiled with zig) and the proxy binary (`iara-s3-proxy`, built with cargo-zigbuild), and upload both to `engine/<version>/`:

```bash
uv pip install ziglang maturin cargo-zigbuild
python -m iara.cloud publish
```

Other commands:

```bash
python -m iara.cloud verify            # list Iara resources left in the account
python -m iara.cloud cleanup --yes     # terminate cluster machines and delete the resources
```

These need AWS credentials in the environment. All three take `--region` (default `us-east-1`); `publish` also takes `--wheel PATH` to upload an existing wheel (nothing is built then, and the proxy already uploaded stays). `verify` and `cleanup` take `--team ID` (or read `IARA_TEAM`) to cover only that team's resources, never the shared engine bucket; without it they cover every team.

### Settings

| Variable | Default | Effect |
|---|---|---|
| `IARA_AWS_ENV_FILE` | | Dotenv file with AWS credentials. |
| `IARA_AWS_REGION` | `us-east-1` | Region for clusters. |
| `IARA_TEAM` | | Team id that suffixes the names of the AWS resources and tags them. |
| `IARA_STUDIO_CIDRS` | server's public IP | CIDRs allowed to SSH to cluster machines. |
| `IARA_STUDIO_DATA` | `~/.iara/studio` | Where Studio keeps its SSH key and cluster records. |
