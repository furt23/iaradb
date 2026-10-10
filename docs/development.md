# Building, Testing & Development

This guide covers setting up a local development environment, compiling the Rust core and Python bindings, running test suites, configuring runtime environment variables, and current project limitations.

---

## Prerequisites

To build Workhouse from source, install the following tools:
- **Rust**: A recent stable Rust toolchain (the crates use Rust edition 2024).
- **Python**: Python 3.10 or newer with [uv](https://docs.astral.sh/uv/) and `maturin`.
- **Node.js**: Node.js 22+ and `pnpm` (required for Workhouse Studio).

---

## Building from Source

### 1. Python & Rust Engine

```bash
# Create a virtual environment and install build tooling
uv venv
uv pip install maturin pyarrow

# Standard development build (thin LTO, fast compilation)
maturin develop --release

# High-performance distribution build (fat LTO, 1 codegen unit for benchmarking)
maturin develop --profile dist

# Install development and test dependencies
uv pip install -e ".[dev]"
```

`.cargo/config.toml` configures Windows builds with `-C target-cpu=native` for maximum local SIMD optimization. Target-neutral cluster builds cross-compile using Zig (`workhouse.cloud publish`).

### 2. Workhouse Studio Web Application

```bash
# Install Next.js and frontend workspace dependencies
pnpm install

# Start Studio development server on http://localhost:3000
pnpm dev
```

---

## Running Tests

Workhouse maintains unit and integration test suites spanning the engine, the Python kernel, and the Studio web frontend:

```bash
# Run engine, SQL, and Python kernel tests
pytest

# Run Studio web frontend unit tests (Vitest)
pnpm test

# Run Studio end-to-end browser tests (Playwright)
pnpm e2e
```

---

## Environment Variables Reference

Workhouse execution can be tuned using the following environment variables:

| Variable | Default | Description |
|---|---|---|
| `WORKHOUSE_PROFILE` | `0` | When set to `1`, prints per-pipeline execution timings, hash join table metrics, and aggregation stats to stderr. |
| `WORKHOUSE_BATCH_SIZE` | `8192` | Number of rows processed per vectorized execution batch. |
| `WORKHOUSE_STRING_VIEW` | `1` | Reads Parquet string columns as zero-copy `Utf8View`. Set to `0` to force legacy `Utf8`. |
| `WORKHOUSE_AGG_PARTITIONS` | `4 × threads` | Number of partitions used when hash aggregation enters radix mode. |
| `WORKHOUSE_MEMORY_LIMIT` | `75% of RAM` (Linux) | Memory budget before query operators spill intermediate state to disk (e.g., `4GB`, `60%`, or bytes). |
| `WORKHOUSE_SPILL_DIR` | System temp dir | Directory where out-of-core spill files are stored. |
| `WORKHOUSE_RESULT_MEMORY` | `128MB` | Studio kernels: query results exceeding this limit are memory-mapped from disk instead of stored in RAM. |
| `WORKHOUSE_IO_THREADS` | `4` | Threads allocated to the background asynchronous object store runtime. |
| `WORKHOUSE_REMOTE_PREFETCH` | `16` | Number of upcoming remote row groups or CSV chunks prefetched concurrently. |
| `WORKHOUSE_REMOTE_PREFETCH_MB`| `256` | Maximum memory buffer for prefetched object store data. |
| `WORKHOUSE_COALESCE_KB` | `1024` | Byte distance threshold for merging nearby storage range requests into one. |
| `WORKHOUSE_MAX_REQUEST_MB` | `64` | Maximum size of an individual range read request. |
| `WORKHOUSE_FETCH_TARGET_MB` | `32` | Target cumulative size of row groups fetched per request batch. |
| `WORKHOUSE_FOOTER_GUESS_KB` | `512` | Size of trailing bytes read to decode Parquet footers in a single network roundtrip. |
| `WORKHOUSE_METADATA_CACHE_MB`| `256` | Memory cache for decoded Parquet metadata (`0` disables). |
| `WORKHOUSE_LIST_CACHE_SECS` | `30` | Duration to cache object store directory listings (`0` disables). |

### Thread Pool Sizing
The worker thread pool defaults to the physical core count of the host machine. To override the thread count, call `wh.set_num_threads(n)` in Python before executing the first query.

---

## Current Limitations

- **SQL Scope**: Regular expressions and `LATERAL` joins are not yet implemented. `DISTINCT` aggregates and `median` are supported over full partition windows, but not over sliding moving frames.
- **Correlated Subqueries**: Correlation decorrelation is currently implemented for equality conditions (scalar aggregates, `EXISTS`, and `IN`).
- **Single-Node Execution**: Workhouse is designed for scale-up on single machines rather than distributed clusters. Under memory limits, individual partition keys must fit in memory (heavy single-key skew is not split further).
- **Object Storage**: S3 and S3-compatible endpoints (such as Cloudflare R2 or MinIO) are supported; local file caching for remote tables is planned.
- **CSV Empty Strings**: An empty quoted string (`""`) in CSV is parsed as null due to an Arrow CSV reader constraint.
- **Studio Multi-Tenancy**: The current release runs as a single-user environment. Role-based access control, user authentication, and shared remote catalogs are scheduled for upcoming team releases.
