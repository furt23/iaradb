# Studio

Iara Studio is a web app for working with a workspace: notebooks that mix Python and SQL, SQL files, a table catalog, query history and profiles, charts, scheduled jobs and clusters.

```bash
pnpm install
python examples/workspace/setup_data.py     # example data (TPC-H, scale factor 0.1)
iara serve examples/workspace          # http://localhost:3870; or: pnpm dev
```

`iara serve` takes `--port`, `--dev` and `--no-browser`.

## How it is built

The browser only renders. The Next.js server handles files, Git and kernel processes, and each kernel is a Python process (`python -m iara.kernel`) that talks to the server in JSON lines over stdio, or over ssh for a cluster. Queries run in the Rust engine inside the kernel.

```
browser (React + MUI)
   | server actions, /api/run (SSE), /api/assist
Next.js server (apps/web/src/server)
   | JSON lines over stdio or ssh
kernel (python -m iara.kernel)
   |
iara-core (Rust)
```

## Workspaces

A workspace is a directory. `iara init [directory]` creates one with an `iara.toml` that lists its tables, and the Python library reads that file. Studio keeps its own catalog in a hidden store instead (see [Catalog](#catalog)). Notebooks and the SQL editor query the tables by name. A script that calls `iara.workspace()` reads `iara.toml`, so it does not see the tables that Studio adds or removes after the first import:

```python
import iara

ws = iara.workspace()      # finds iara.toml from the current directory upward
ws.sql("select count(*) from lineitem").collect()
```

Tables can be Parquet, CSV or JSON files, directories or globs, local or `s3://`. Schemas are declared in `[schemas.<name>]` sections. Studio's catalog has the same format. For the format see the docstring of `python/iara/workspaces.py`.

Other catalogs are declared with `[catalogs.<name>]` sections. A catalog has its own schemas and tables, written like the default catalog's ones with the catalog name in front:

```toml
[catalogs.sales]
description = "Sales data"

[catalogs.sales.schemas.raw]
location = "s3://bucket/raw"

[catalogs.sales.tables.orders]
path = "data/orders.parquet"

[catalogs.sales.tables.raw.events]
path = "data/events"
```

`[catalogs.sales.tables.orders]` is the table `sales.main.orders`, and `[catalogs.sales.tables.raw.events]` is `sales.raw.events`. The default catalog is named after `[workspace] name` and keeps the top-level `[tables]` and `[schemas]` sections. A catalog cannot take the default catalog's name.

## Notebooks

- A notebook is a `.py` file in marimo format. Each cell is a function: its parameters are the variables it reads and its return values are the variables it defines. The file runs with `python notebook.py`. A notebook that redefines a variable in several cells does not run in marimo itself.
- Running a cell runs it, and the cells it reads from that have no value yet. The cells that read its values are marked stale; they run when you run them. Kernel → Run dependent cells automatically (a per-notebook choice, kept by the browser) runs them right away instead, as marimo does. Run all, and changing a widget, run everything that depends on it.
- A variable can be redefined by later cells (`df = df.filter(...)`). A cell reads the nearest definition above it. A variable defined by one cell only is read from that cell wherever it is.
- Python and SQL cells share data. A DataFrame from a Python cell can be queried by name in SQL, and a SQL cell's result is a variable in later Python cells.
- Notebooks and queries have an 8-character id, so links such as `/notebooks/12yd3sx9` survive renames and moves. A cell has an id too, and "Copy link to cell" links to it.
- The file menu renames, moves, duplicates, exports (`.py`, `.ipynb`, Markdown), schedules as a job and deletes. The kernel menu interrupts, restarts, restarts and clears outputs, or restarts and runs all.
- The side panel shows an outline built from Markdown headings and the variables defined in the kernel.
- Python cells have completion (Jedi). Syntax errors, undefined names and SQL errors are marked while you type.
- The imports of a notebook live in a setup cell (`with app.setup:`). The Studio hides it from the cell list. Kernel → Show setup code opens it. New notebooks start with `import marimo as mo`, `import iara` and `ws = iara.workspace()`.
- Frames, readers and `sql` are on `iara` (`iara.scan_parquet(...)`). Expression functions are in `iara.functions`: import it under the name you like, e.g. `from iara import functions as F`, then `F.col("x") > 5`, `F.sum("amount")`, `F.when(...)`. Its `sum`, `min`, `max`, `all` and `len` are aggregates, so import the module rather than `*`.
- A cell does not show the frame it ends with, and `collect()` only collects: a frame shows its first 500 rows with `df.preview()` (or `iara.preview(df)`, `df.preview(50)` for fewer). A LazyFrame runs with a limit, and its profile and plan come along. The table's CSV and Parquet downloads, charts and the Wrangle tab use all the rows. SQL cells and the SQL editor show the first 500 rows of their result; the cell's variable has all of them. Other tables (pandas, pyarrow, polars) a cell ends with are shown as before, their first 500 rows.

## Widgets

`iara.widgets` defines named inputs for a notebook: `text`, `number`, `dropdown`, `multiselect`, `checkbox` and `date`. Each call defines the widget and returns its value.

```python
region = iara.widgets.dropdown("region", "north", ["north", "south"], label="Region")
```

The notebook's widget bar shows the widgets. Changing a value re-runs the cells that read it. A SQL cell binds `:name` placeholders to widget values. Outside the Studio (a script or a job without a kernel), a widget takes its value from the environment variable `IARA_PARAM_<NAME>` (the name in upper case) when it is set, and from its default otherwise.

## Results

Results stay in the kernel and the browser fetches pages as needed, so a result can be larger than the browser can hold. Results over `IARA_RESULT_MEMORY` (128 MB) are kept on disk. You can sort a result and download it as CSV or Parquet.

Queries show live progress and can be cancelled. SQL cells and lazy frames show a profile per pipeline: time, rows, memory peak and spilled bytes.

### Query parameters

A `.sql` file's `:name` placeholders are detected and get a field in the parameter bar above the editor. The header comment keeps each parameter's type and default:

```sql
-- iara:params {"region":{"type":"select","options":["EU","US"],"default":"EU"}}
select * from sales.orders where region = :region
```

Types: `text`, `number`, `boolean`, `date` and `select` (with `options`). The header is a SQL comment, so the file still runs in other tools.

### Charts

Every table result has a Chart tab with bar, line, area, scatter and histogram charts. Values are aggregated (sum, average, count, min, max) in the kernel before they are sent, optionally split into series by a column. The chart settings are saved in the notebook, or in the header comment of a `.sql` file.

### Analyze

Analyze on a query runs it with full profiling and opens a report at `/analyze`: time, rows, peak memory, a graph of the operators with row counts and times, a pipeline timeline and the physical plan. Past reports are listed there.

## Catalog

The Data section lists catalogs at the top level, the default catalog first and then the others by name. Each catalog lists its schemas (`main` first) and their tables. A table of the default catalog is named as in SQL (`sales.orders`; the default schema is `main`), and a table of another catalog as `catalog.schema.table`. New catalog adds a catalog; a catalog with tables or schemas besides `main` cannot be removed until they are removed. New schema and Add table let you choose the catalog to put the schema or table in. SQL completion offers the `catalog.schema.table` names. For each table it shows the location, size, columns, Parquet statistics and sample rows. You can add tables from the Data panel or from a file in the file tree, and remove them without deleting the data.

The catalog (tables, schemas and storage settings) is kept in a hidden store, not in `iara.toml`. Locally it is `.iara/catalog.toml` in the workspace folder. With `IARA_BUCKET` set (team mode) it is `_iara/catalog.toml` in that bucket, and `IARA_STORAGE_ENDPOINT` gives the bucket's S3 endpoint (empty for AWS S3). In team mode, tables created with SQL go under `warehouse/` in the bucket. The first time Studio opens a workspace, it imports its `iara.toml` if there is one. After that it ignores that file and hides it from the file tree, so the library, which still reads `iara.toml`, does not see later changes made in Studio.

`CREATE TABLE ... AS SELECT` writes a Delta table to the workspace's warehouse directory (`warehouse` under `[workspace]` in the catalog; in team mode, `s3://<IARA_BUCKET>/warehouse/`) and registers the table. `USING PARQUET` writes plain Parquet instead. See [delta.md](delta.md). The History tab of a Delta table lists its commits; a version can be queried or restored from there. `DROP TABLE` and `DROP SCHEMA [CASCADE]` update the catalog.

A schema can have a `location` (`[schemas.<name>]`, an `s3://` URL or a workspace folder). Every subfolder of it is a table of that schema, named after the folder; folders starting with `_` or `.` and names that are not identifiers are skipped. Tables declared in `[tables]` win over discovered ones, and discovered tables are never written to the catalog. Studio lists the location with the credentials and `[storage."s3://..."]` settings of the catalog and caches the listing for 30 seconds (the refresh button in the Data panel reads it again). `CREATE TABLE` in such a schema writes into the location; `DROP TABLE` is refused for these tables, delete the folder instead.

## Jobs

A job runs notebooks or SQL files on a cron schedule (UTC) or on demand, on an existing cluster or on a new one that is removed afterwards. Studio keeps run history, durations, statuses and logs. Each job is a file `jobs/<id>.toml` in the workspace.

```toml
name = "Nightly sales"
schedule = "0 6 * * *"
cluster = "job"
timeout_minutes = 60

[params]
region = "EU"

[[task]]
key = "load"
target = "notebooks/load.py"
max_retries = 2
retry_backoff_seconds = 30

[[task]]
key = "report"
target = "queries/report.sql"
depends_on = ["load"]
run_if = "all_success"
[task.params]
region = "US"

[[notify]]
on = ["failure"]
webhook = "https://example.com/hooks/sales"
```

- A job has either one `target` or one or more `[[task]]` tables. A file with only `target` is a single task keyed `main`.
- `key` names the task: letters, digits, `_` and `-`. `depends_on` lists the tasks that run first. The graph of tasks must not have cycles.
- `run_if` sets when a task runs, from how its upstream tasks ended: `all_success` (default), `all_done`, `at_least_one_success`, `none_failed` or `all_failed`.
- `max_retries` (0 to 10) and `retry_backoff_seconds` (0 to 3600) retry a failed task. `timeout_minutes` (1 to 1440) limits one task. Without it, the job's timeout applies.
- `[params]` at the job level and `[task.params]` per task pass values to the task's widgets and parameters. Task values win over job values.
- `[[notify]]` posts JSON to a webhook (`http` or `https`) on the events `start`, `success` and `failure`. A delivery is tried up to three times on network errors, timeouts and 5xx responses. A failed delivery is logged and does not change the run.

Run with parameters… starts a run with other values for that run only; they win over the job and task values. The run view lists each task with its status and attempt, and shows each task's log. The task graph colours each box by the task's status in the selected run.

## Clusters

The Compute section creates and manages AWS clusters. A Local entry, which runs kernels as child processes of Studio, exists only in development or with `IARA_LOCAL_COMPUTE=1` (`iara serve` sets it); in a production build run any other way, including the Docker image, there is none, so notebooks run on clusters. Local kernels get a short list of environment variables (the basics, `AWS_*` storage keys and the engine settings), not Studio's own environment. Cluster kernels run as an unprivileged user without sudo. See [storage-and-cloud.md](storage-and-cloud.md#clusters-on-aws).

## Data Wrangler

The Data Wrangler builds a cleaning recipe on a table or a query result: open the Wrangler section, the Wrangle tab of a table in Data, or the Wrangle tab of a result.

- Steps: filter, fill or drop nulls, remove duplicates, trim, change case, replace (text or regex), split, rename, cast, drop columns, round, one-hot encode, sort. Steps can be switched off, and selecting one shows the data up to it.
- The recipe runs in the kernel as one SQL query over all rows. The grid shows its first 500 rows; the bar under each column header and the column statistics (nulls, distinct values, min, max, mean, median, most frequent values) count all rows.
- Code shows that query, and the same query from Python (`ws.sql(...)`).

## Navigation

- The left rail switches between Workspace, Data, Wrangler, SQL editor, Query history, Jobs, Compute and Git.
- Ctrl+K opens any notebook, query, table or page by name. Ctrl+B toggles the side panel.
- Notebooks open in tabs. A pane can be split, up to four panes, and tabs can be dragged between panes.

## Settings

| Variable | Default | Effect |
|---|---|---|
| `IARA_WORKSPACE` | the example workspace in a checkout, else the current directory | Workspace Studio opens. |
| `IARA_PYTHON` | | Python interpreter that runs kernels. |
| `IARA_KERNEL_IDLE_MINUTES` | `60` | Idle time before a kernel is stopped. |
| `IARA_LOCAL_COMPUTE` | on outside production, off in production; `iara serve` sets `1` | `1` offers the Local cluster (kernels on Studio's machine, running as Studio's user, so able to read its data folder), `0` removes it. |
| `IARA_RESULT_MEMORY` | `128MB` | Largest result kept in memory. |
| `IARA_STUDIO_DIR` | the checkout's `apps/web` | Where `iara serve` finds the web app. |
| `IARA_SCHEDULER` | on | `0` turns the job scheduler off. |
