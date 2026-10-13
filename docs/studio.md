# Studio

Workhouse Studio is a web app for working with a workspace: notebooks that mix Python and SQL, SQL files, a table catalog, query history and profiles, charts, scheduled jobs and clusters.

```bash
pnpm install
python examples/workspace/setup_data.py     # example data (TPC-H, scale factor 0.1)
workhouse serve examples/workspace          # http://localhost:3870; or: pnpm dev
```

`workhouse serve` takes `--port`, `--dev` and `--no-browser`.

## How it is built

The browser only renders. The Next.js server handles files, Git and kernel processes, and each kernel is a Python process (`python -m workhouse.kernel`) that talks to the server in JSON lines over stdio, or over ssh for a cluster. Queries run in the Rust engine inside the kernel.

```
browser (React + MUI)
   | server actions, /api/run (SSE), /api/assist
Next.js server (apps/web/src/server)
   | JSON lines over stdio or ssh
kernel (python -m workhouse.kernel)
   |
workhouse-core (Rust)
```

## Workspaces

A workspace is a directory with a `workhouse.toml` that lists its tables. `workhouse init [directory]` creates one. Notebooks and the SQL editor query the tables by name. A script can use the same catalog:

```python
import workhouse as wh

ws = wh.workspace()      # finds workhouse.toml from the current directory upward
ws.sql("select count(*) from lineitem").collect()
```

Tables can be Parquet, CSV or JSON files, directories or globs, local or `s3://`. Schemas are declared in the same file. For the file format see the docstring of `python/workhouse/workspaces.py`.

## Notebooks

- A notebook is a `.py` file in marimo format. Each cell is a function: its parameters are the variables it reads and its return values are the variables it defines. The file can be opened in marimo and run with `python notebook.py`.
- Running a cell also runs the cells that depend on it, and any stale cells it depends on, in dependency order.
- Python and SQL cells share data. A DataFrame from a Python cell can be queried by name in SQL, and a SQL cell's result is a variable in later Python cells.
- Notebooks and queries have an 8-character id, so links such as `/notebooks/12yd3sx9` survive renames and moves. A cell has an id too, and "Copy link to cell" links to it.
- The file menu renames, moves, duplicates, exports (`.py`, `.ipynb`, Markdown), schedules as a job and deletes. The kernel menu interrupts, restarts, restarts and clears outputs, or restarts and runs all.
- The side panel shows an outline built from Markdown headings and the variables defined in the kernel.
- Python cells have completion (Jedi). Syntax errors, undefined names, names defined twice and SQL errors are marked while you type.
- The imports of a notebook live in a setup cell (`with app.setup:`). The Studio hides it from the cell list. Kernel → Show setup code opens it. New notebooks start with `import marimo as mo`, `import workhouse as wh` and `ws = wh.workspace()`.

## Widgets

`wh.widgets` defines named inputs for a notebook: `text`, `number`, `dropdown`, `multiselect`, `checkbox` and `date`. Each call defines the widget and returns its value.

```python
region = wh.widgets.dropdown("region", "north", ["north", "south"], label="Region")
```

The notebook's widget bar shows the widgets. Changing a value re-runs the cells that read it. A SQL cell binds `:name` placeholders to widget values. Outside the Studio (a script or a job without a kernel), a widget takes its value from the environment variable `WORKHOUSE_PARAM_<NAME>` (the name in upper case) when it is set, and from its default otherwise.

## Results

Results stay in the kernel and the browser fetches pages as needed, so a result can be larger than the browser can hold. Results over `WORKHOUSE_RESULT_MEMORY` (128 MB) are kept on disk. You can sort a result and download it as CSV or Parquet.

Queries show live progress and can be cancelled. SQL cells and lazy frames show a profile per pipeline: time, rows, memory peak and spilled bytes.

### Query parameters

A `.sql` file's `:name` placeholders are detected and get a field in the parameter bar above the editor. The header comment keeps each parameter's type and default:

```sql
-- workhouse:params {"region":{"type":"select","options":["EU","US"],"default":"EU"}}
select * from sales.orders where region = :region
```

Types: `text`, `number`, `boolean`, `date` and `select` (with `options`). The header is a SQL comment, so the file still runs in other tools.

### Charts

Every table result has a Chart tab with bar, line, area, scatter and histogram charts. Values are aggregated (sum, average, count, min, max) in the kernel before they are sent, optionally split into series by a column. The chart settings are saved in the notebook, or in the header comment of a `.sql` file.

### Analyze

Analyze on a query runs it with full profiling and opens a report at `/analyze`: time, rows, peak memory, a graph of the operators with row counts and times, a pipeline timeline and the physical plan. Past reports are listed there.

## Catalog

The Data section lists tables by schema (`sales.orders`; the default schema is `main`). For each table it shows the location, size, columns, Parquet statistics and sample rows. You can add tables from the Data panel or from a file in the file tree, and remove them without deleting the data.

`CREATE TABLE ... AS SELECT` writes a Delta table to the workspace's warehouse directory (`warehouse` under `[workspace]` in `workhouse.toml`) and registers the table. `USING PARQUET` writes plain Parquet instead. See [delta.md](delta.md). The History tab of a Delta table lists its commits; a version can be queried or restored from there. `DROP TABLE` and `DROP SCHEMA [CASCADE]` update the catalog.

A schema can have a `location` (`[schemas.<name>]`, an `s3://` URL or a workspace folder). Every subfolder of it is a table of that schema, named after the folder; folders starting with `_` or `.` and names that are not identifiers are skipped. Tables declared in `[tables]` win over discovered ones, and discovered tables are never written to `workhouse.toml`. Studio lists the location with the credentials and `[storage."s3://..."]` settings of the workspace and caches the listing for 30 seconds (the refresh button in the Data panel reads it again). `CREATE TABLE` in such a schema writes into the location; `DROP TABLE` is refused for these tables, delete the folder instead.

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

The Compute section creates and manages AWS clusters and the Local kernels. See [storage-and-cloud.md](storage-and-cloud.md#clusters-on-aws).

## Navigation

- The left rail switches between Workspace, Data, SQL editor, Query history, Jobs, Compute and Git.
- Ctrl+K opens any notebook, query, table or page by name. Ctrl+B toggles the side panel.
- Notebooks open in tabs. A pane can be split, up to four panes, and tabs can be dragged between panes.

## Settings

| Variable | Default | Effect |
|---|---|---|
| `WORKHOUSE_WORKSPACE` | the example workspace in a checkout, else the current directory | Workspace Studio opens. |
| `WORKHOUSE_PYTHON` | | Python interpreter that runs kernels. |
| `WORKHOUSE_KERNEL_IDLE_MINUTES` | `60` | Idle time before a kernel is stopped. |
| `WORKHOUSE_RESULT_MEMORY` | `128MB` | Largest result kept in memory. |
| `WORKHOUSE_STUDIO_DIR` | the checkout's `apps/web` | Where `workhouse serve` finds the web app. |
| `WORKHOUSE_SCHEDULER` | on | `0` turns the job scheduler off. |
