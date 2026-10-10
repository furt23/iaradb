# Workhouse Studio

Workhouse Studio is a collaborative, browser-based workspace for the Workhouse engine: reactive notebooks that mix Python and SQL, an integrated data catalog, a SQL editor with query history, visual query plan profilers, interactive charts, and on-demand compute management.

```bash
pnpm install                                   # install web app dependencies (Next.js + MUI)
python examples/workspace/setup_data.py        # generate example data (TPC-H SF0.1)
workhouse serve examples/workspace             # or: pnpm dev (runs using the example workspace)
```

---

## Architecture

Workhouse Studio separates presentation from compute. The browser acts as a pure rendering client, communicating with Next.js server actions and streaming APIs, which in turn manage isolated Python kernel processes communicating with the Rust engine:

```
browser (React + MUI, renders only)
   │  server actions (short calls) · /api/run (SSE: cell states, output, progress) · /api/assist
Next.js server ── apps/web/src/server   kernel manager · workspace files · Git
   │  JSON lines over stdio (a child process, or ssh to a compute target)
kernel (python -m workhouse.kernel) ── notebook graph · cell runner · results · catalog
   │
workhouse-core (Rust)                  cancellable, observable queries
```

---

## Core Features

### Sections & Navigation Rail
A collapsible rail on the left switches between main sections:
- **Workspace**: File tree with notebooks and SQL queries open in tabs.
- **Data**: The catalog viewer for schemas and tables.
- **SQL Editor**: Scratchpad and query execution editor.
- **Query History**: Audit log of past executions with direct links to plan analyses.
- **Jobs**: Scheduled and manual batch runs.
- **Compute**: Local and cloud compute cluster management.
- **Git**: Workspace version control status.

Each section brings its own dedicated side panel.
- Press **Ctrl+K** to open any notebook, query, table, or page by name via quick open.
- Press **Ctrl+B** (or click the active section icon) to toggle the side panel.
- With nothing open, the workspace shows getting started shortcuts and recently opened files.

### Workspaces
A workspace is a directory containing a `workhouse.toml` catalog file (`workhouse init` initializes one). The catalog defines named datasets from Parquet and CSV files. Every notebook and the SQL editor queries these tables directly by name. External scripts connect to the same catalog session using:
```python
import workhouse as wh
ws = wh.workspace()
```

### Notebooks in marimo Format
Notebooks are saved as standard `.py` files using the marimo format:
- Each cell is a pure function whose parameters are the variables it reads, and whose return values are the variables it defines.
- Files diff cleanly in Git, can be opened directly with marimo, and execute as ordinary scripts (`python notebook.py`).

### Reactive Cell Execution
Running a cell automatically executes all downstream dependent cells, as well as unexecuted or edited ancestor cells in topological dependency order.
- Python and SQL cells share data seamlessly: a DataFrame created in Python is immediately queryable as a table in SQL cells, and SQL cell outputs are exported as variables for subsequent Python cells.

### Results, Profiles & Plan Analysis
- **Out-of-Core Result Handling**: Results stay in the kernel process and are paged into the browser on demand, supporting client-side sorting and CSV/Parquet downloads. Large query outputs stream directly to disk and are memory-mapped back, allowing results to exceed physical RAM limits.
- **Pipeline Profiles**: SQL cells and lazy frames display execution metrics per pipeline (wall time, row counts, memory peak, spilled bytes) and the underlying physical execution plan.
- **Live Progress & Cancellation**: Running queries report live batch progress and can be cancelled on demand.

### Stable Links
Notebooks and queries receive unique 8-character identifiers (`/notebooks/12yd3sx9`). Links persist across file renames and moves. Cells retain an explicit ID attribute (`@app.cell(id="...")`), enabling direct sharing via "Copy link to cell" which auto-scrolls and highlights the target cell.

### Tabs & Multi-Pane Layout
- Notebooks open as tabs inside resizable split panes (up to four panes side-by-side, stacked, or arranged in a grid).
- Tabs can be dragged between panes and positions are remembered.
- Notebook instances preserve their execution state, cell outputs, and running tasks when switching tabs or views: each notebook renders once into its own DOM subtree.

### Notebook Controls
- **File Menu**: Rename, move, duplicate, export as `.py` (marimo), `.ipynb` (Jupyter notebook v4), or Markdown, copy shareable link, schedule as a job, and delete.
- **Kernel Menu**: Interrupt running execution, restart kernel (variables clear, outputs stay marked stale with an amber indicator), restart and clear outputs, restart and run all, or clear outputs. Individual cells provide their own output clearing controls.

### Document Outline & Variables
- **Outline View**: The notebook side panel renders an interactive table of contents parsed from Markdown headings, nested hierarchically or by numbering (e.g., 1, 1.1, 2). Clicking an outline node scrolls to the heading.
- **Variables View**: Lists active variables defined in the kernel along with their data types and summaries.

### Intelligent In-Cell Editing
- Cells can be reordered via drag handles or keyboard shortcuts, and code or output sections can be collapsed individually.
- Python cells provide inline autocompletion with type signatures and documentation, powered by Jedi analyzing the cell alongside live kernel values.
- Syntax errors, undefined variables, name collisions across cells, and SQL errors are underlined as you type on an independent background thread without stalling cell execution.

### On-Demand Compute Clusters
The **Compute** section manages ephemeral compute environments:
- **Cluster Profiles**: Configure machine sizes (EC2 instances), idle auto-termination timeouts, and attached storage.
- **Fast Startup**: Machines launch in under a minute, attach IAM roles scoped to workspace buckets, and stream data directly from object stores.
- **Toolbar Cluster Dropdown**: Notebooks attach to clusters from their toolbar, displaying current cluster status, uptime, idle timer, and accumulated cost.
- **Cluster Management**: View active kernels, restart or stop kernels, attach or detach notebooks, inspect lifecycle event logs, and clone cluster configurations.
- **Local Fallback**: A "Local" cluster manages kernels running on the host machine during development.

### Data Catalog
Browse registered tables grouped by schema (`sales.orders`; tables without explicit schemas default to `main`). Tables are read directly from `workhouse.toml` without requiring an active cluster:
- Inspect table locations, disk sizes, column schemas, Parquet statistics, and sample rows.
- Register new tables from the Data panel or from data files in the file explorer.
- Remove tables from the catalog without deleting underlying data files.

### Visual Plan Analysis (`/analyze`)
Clicking "Analyze" on any query executes it under detailed profiling and opens an analysis report:
- Summary cards for execution time, output row count, peak memory usage, and pipeline count.
- Interactive operator graph displaying per-node row throughput and timings.
- Detailed operator inspector drawer showing operator schemas and runtime metrics.
- Wall-clock pipeline timeline visualization and complete textual physical plan.
- Past analyses are saved and accessible at `/analyze`.

### Interactive Charts
Every tabular query output includes a **Chart** tab:
- Supports bar charts, line graphs, area charts, scatter plots, and histograms.
- Aggregates by sum, average, count, minimum, or maximum, with grouping into series by column.
- Aggregations are calculated in the kernel prior to transfer, allowing billion-row datasets to be visualized efficiently.
- Chart configurations persist directly in notebook files or in the header comments of `.sql` files.

### Transactional SQL DDL
- `CREATE TABLE ... AS SELECT` in a notebook or SQL editor writes Parquet datasets directly to the workspace warehouse directory (`[workspace] warehouse` in `workhouse.toml`) and registers the table in the catalog.
- `DROP TABLE` and `DROP SCHEMA [CASCADE]` update the catalog transactionally.

### Scheduled Jobs
Automate notebook and query execution on a schedule (cron UTC) or manually:
- Run jobs on dedicated ephemeral clusters created for the run and terminated immediately upon completion, or run on existing clusters.
- View execution history, run durations, statuses, and complete log outputs.
- Job definitions are versioned as `jobs/*.toml` files inside the workspace.
