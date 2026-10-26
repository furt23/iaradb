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

Use the GNU host toolchain, which bundles a MinGW linker:

```bash
rustup toolchain install stable-x86_64-pc-windows-gnu
rustup target add x86_64-pc-windows-gnullvm --toolchain stable-x86_64-pc-windows-gnu
```

Point the gnullvm target at the bundled MinGW in `.cargo/config.toml` (or `%USERPROFILE%\.cargo\config.toml`); replace `<user>` with your user name:

```toml
[target.x86_64-pc-windows-gnullvm]
linker = "C:/Users/<user>/.rustup/toolchains/stable-x86_64-pc-windows-gnu/lib/rustlib/x86_64-pc-windows-gnu/bin/self-contained/x86_64-w64-mingw32-gcc.exe"
```

Build with that toolchain:

```bash
rustup run stable-x86_64-pc-windows-gnu maturin develop --release --target x86_64-pc-windows-gnullvm
```

The resulting `_iara.pyd` loads `libunwind.dll` at runtime. Copy it from an [llvm-mingw](https://github.com/mstorsjo/llvm-mingw/releases) release (`x86_64-w64-mingw32/bin/libunwind.dll`) next to `python/iara/_iara.pyd`, or put that folder on `PATH`.

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

Or, from an installed package, `iara serve <workspace>` (options: `--port`, `--dev`, `--no-browser`). `iara init [directory]` creates a workspace.

## Tests

```bash
pytest          # engine, SQL, cloud and kernel tests (tests/)
pnpm test       # Studio unit tests (Vitest)
pnpm e2e        # Studio browser tests (Playwright)
cargo test -p iara-core
```

## Settings

| Variable | Default | Effect |
|---|---|---|
| `IARA_PROFILE` | `0` | `1` prints pipeline timings to stderr. |
| `IARA_BATCH_SIZE` | `8192` | Rows per batch. |
| `IARA_STRING_VIEW` | `1` | `0` reads Parquet strings as `Utf8`. |
| `IARA_AGG_PARTITIONS` | `4 x threads` | Partitions of the shared tables a high-cardinality aggregation uses. |
| `IARA_MEMORY_LIMIT` | 75% of RAM on Linux, none elsewhere | Bytes, a unit (`4GB`) or a percentage (`60%`). |
| `IARA_SPILL_DIR` | system temp dir | Where spill files go. |
| `IARA_RESULT_MEMORY` | `128MB` | Notebook results larger than this are kept on disk instead of in memory. |
| `IARA_WORKSPACE` | | Workspace directory for the kernel and Studio. |
| `IARA_PYTHON` | | Python interpreter Studio uses for kernels. |
| `IARA_KERNEL_IDLE_MINUTES` | `60` | Idle time before Studio stops a kernel. |

The thread count defaults to the number of cores. Change it with `iara.set_num_threads(n)` before the first query. Object store variables are in [storage-and-cloud.md](storage-and-cloud.md); Studio's are in [studio.md](studio.md).

## Known limits

- Correlated subqueries are decorrelated for equality conditions only.
- `DISTINCT` aggregates and `median` work over whole partitions, not sliding frames.
- Under a memory limit, one partition key must fit in memory.
- An empty quoted string (`""`) in CSV is read as null.
- Studio has no sign-in unless `IARA_AUTH=auth0` is set; then access follows the email lists in [studio.md](studio.md#sign-in).
- Data grants do not yet apply to notebooks, the SQL editor or the Data panel's previews ([studio.md](studio.md#data-permissions)).
