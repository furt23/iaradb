# Development

Building from source, running the tests, and the environment variables.

## Install

Wheels will be published to PyPI; until then, build from source.

## Requirements

- Rust, recent stable (the crates use edition 2024).
- Python 3.10 or newer, with [uv](https://docs.astral.sh/uv/) and `maturin`.
- Node.js 22 or newer and `pnpm`, for Studio.
- On Windows, the Visual Studio C++ build tools (MSVC).

### Without Visual Studio

<!-- TODO: verified commands -->
Use llvm-mingw and Rust's `x86_64-pc-windows-gnullvm` target:

```bash
rustup target add x86_64-pc-windows-gnullvm
maturin develop --release --target x86_64-pc-windows-gnullvm
```

## Build the engine

```bash
uv venv
uv pip install maturin pyarrow
maturin develop --release          # thin LTO, builds faster
maturin develop --profile dist     # fat LTO, one codegen unit; use for benchmarks
maturin develop --profile fast     # no LTO, quick iteration
uv pip install -e ".[dev]"         # test dependencies
```

On Windows MSVC, `.cargo/config.toml` builds with `target-cpu=native`, so the binary only runs on CPUs like the build machine.

## Run Studio

```bash
pnpm install
pnpm dev                           # http://localhost:3870, on the example workspace
```

Or, from an installed package, `workhouse serve <workspace>` (options: `--port`, `--dev`, `--no-browser`). `workhouse init [directory]` creates a workspace.

## Tests

```bash
pytest          # engine, SQL, cloud and kernel tests (tests/)
pnpm test       # Studio unit tests (Vitest)
pnpm e2e        # Studio browser tests (Playwright)
cargo test -p workhouse-core
```

## Settings

| Variable | Default | Effect |
|---|---|---|
| `WORKHOUSE_PROFILE` | `0` | `1` prints pipeline timings to stderr. |
| `WORKHOUSE_BATCH_SIZE` | `8192` | Rows per batch. |
| `WORKHOUSE_STRING_VIEW` | `1` | `0` reads Parquet strings as `Utf8`. |
| `WORKHOUSE_AGG_PARTITIONS` | `4 x threads` | Partitions when aggregation switches to radix mode. |
| `WORKHOUSE_MEMORY_LIMIT` | 75% of RAM on Linux, none elsewhere | Bytes, a unit (`4GB`) or a percentage (`60%`). |
| `WORKHOUSE_SPILL_DIR` | system temp dir | Where spill files go. |
| `WORKHOUSE_RESULT_MEMORY` | `128MB` | Notebook results larger than this are kept on disk instead of in memory. |
| `WORKHOUSE_WORKSPACE` | | Workspace directory for the kernel and Studio. |
| `WORKHOUSE_PYTHON` | | Python interpreter Studio uses for kernels. |
| `WORKHOUSE_KERNEL_IDLE_MINUTES` | `60` | Idle time before Studio stops a kernel. |

The thread count defaults to the number of cores. Change it with `wh.set_num_threads(n)` before the first query. Object store variables are in [storage-and-cloud.md](storage-and-cloud.md); Studio's are in [studio.md](studio.md).

## Known limits

- Correlated subqueries are decorrelated for equality conditions only.
- `DISTINCT` aggregates and `median` work over whole partitions, not sliding frames.
- Under a memory limit, one partition key must fit in memory.
- An empty quoted string (`""`) in CSV is read as null.
- Studio is single-user: no authentication or access control.
