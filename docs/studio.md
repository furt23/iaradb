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
- Running a cell runs it, and the cells it reads from that have no value yet. The cells that read its values are marked stale; they run when you run them. Kernel → Run dependent cells automatically (a per-notebook choice, kept by the browser) runs them right away instead, as marimo does. Run all and the keys that run several cells stop at the first cell that fails, as a notebook does; the cells after it keep their state. Running one cell does not stop at a failure: only the cells that read from the failed cell are blocked, and they say why. Changing a widget runs everything that depends on it, under the same rule.
- Keys (Ctrl, or Cmd on Mac): Shift+Enter or Ctrl+Enter runs the cell. Ctrl+Shift+Enter runs the cells above it. Ctrl+Alt+Enter runs it and the cells below. Ctrl+. stops the run. Ctrl+F opens find and replace over every cell with code showing: match case, regular expression (replacements may use `$1`) and whole word, Enter for the next match, Shift+Enter for the previous, and Replace or Replace all.
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

## Query history and lineage

Studio keeps a log of the runs its kernels make: each SQL statement, and each Python cell that read or wrote a table. A run has who started it, where it ran, its time, rows and memory, and the tables it read and wrote with their Delta version. The log is in Studio's data folder (`system/` under `IARA_STUDIO_DATA`), so it outlives the clusters.

- The Query history page lists the newest runs. It needs no cluster.
- The Lineage tab of a table in Data lists what wrote the table and what read it: notebooks, the SQL editor, jobs, dashboards and Iara. For each one it shows who ran it last and when, the table's version, and for a writer the tables the same run read.
- A read by path counts too: `iara.scan_delta("s3://bucket/warehouse/sales/orders")` is a read of `sales.orders` when the catalog has that table at that location.

Not recorded: table previews, the Data Wrangler, and files written from Python with `sink_parquet` or `sink_csv`. Runs a job starts are recorded without a user. A Python cell that runs more than 32 queries keeps the reads of its last 32.

### System catalog

The `system` catalog holds Studio's own records as tables, queried like any other table:

| Table | Rows |
|---|---|
| `system.main.queries` | One per run: `id`, `ts`, `user`, `kernel`, `cluster`, `source`, `kind` (`sql` or `python`), `query`, `elapsed_ms`, `rows`, `error`, `memory_peak`, `spilled_bytes`. |
| `system.main.query_tables` | One per table a run read or wrote: `query_id`, `ts`, `user`, `kernel`, `source`, `access` (`read` or `write`), `table`, `location`, `version`, `operation`. |
| `system.main.job_runs` | One per job run, dashboard refreshes included: `id`, `job`, `trigger`, `status`, `started_at`, `ended_at`, `cluster`, `error`, `summary`, `tasks`. |

Studio writes them as Parquet files every minute, when something changed: under `_iara/system/` of the team bucket, or in the workspace's `.iara/system/` folder without one. A query therefore sees runs up to a minute old. The catalog appears once the first table is written, and it is read-only in the Data panel. [Data permissions](#data-permissions) apply to it as to any other catalog; `queries` holds the query text of every user.

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
- A `target` is a notebook (`.py`) or a query file (`.sql`). Dashboards are not job targets: a dashboard schedules its own refresh (see [Dashboards](#dashboards)).
- `key` names the task: letters, digits, `_` and `-`. `depends_on` lists the tasks that run first. The graph of tasks must not have cycles.
- `run_if` sets when a task runs, from how its upstream tasks ended: `all_success` (default), `all_done`, `at_least_one_success`, `none_failed` or `all_failed`.
- `max_retries` (0 to 10) and `retry_backoff_seconds` (0 to 3600) retry a failed task. `timeout_minutes` (1 to 1440) limits one task. Without it, the job's timeout applies.
- `[params]` at the job level and `[task.params]` per task pass values to the task's widgets and parameters. Task values win over job values.
- `[[notify]]` posts JSON to a webhook (`http` or `https`) on the events `start`, `success` and `failure`. A delivery is tried up to three times on network errors, timeouts and 5xx responses. A failed delivery is logged and does not change the run.

Run with parameters… starts a run with other values for that run only; they win over the job and task values. The run view lists each task with its status and attempt, and shows each task's log. The task graph colours each box by the task's status in the selected run.

## Clusters

The Compute section creates and manages AWS clusters. A Local entry, which runs kernels as child processes of Studio, exists only in development or with `IARA_LOCAL_COMPUTE=1` (`iara serve` sets it); in a production build run any other way, including the Docker image, there is none, so notebooks run on clusters. Local kernels get a short list of environment variables (the basics, `AWS_*` storage keys and the engine settings), not Studio's own environment. Cluster kernels run as an unprivileged user without sudo. Catalog reads need no cluster: a table's details (columns, row count, size, statistics), its Delta history, the columns for SQL completion and the plans of the AI tools come from a kernel Studio runs itself, which only answers those requests and never runs notebook code. Row counts come from Parquet footers and the Delta log; CSV and JSON tables show none, since counting them would read them whole. A notebook whose cluster is not running still opens, is edited and saved (Studio parses and writes the file without running it); its run controls appear once the cluster runs. Previews and queries run on a cluster. See [storage-and-cloud.md](storage-and-cloud.md#clusters-on-aws).

## Data Wrangler

The Data Wrangler builds a cleaning recipe on a table or a query result: open the Wrangler section, the Wrangle tab of a table in Data, or the Wrangle tab of a result.

- Steps: filter, fill or drop nulls, remove duplicates, trim, change case, replace (text or regex), split, rename, cast, drop columns, round, one-hot encode, sort. Steps can be switched off, and selecting one shows the data up to it.
- The recipe runs in the kernel as one SQL query over all rows. The grid shows its first 500 rows; the bar under each column header and the column statistics (nulls, distinct values, min, max, mean, median, most frequent values) count all rows.
- Code shows that query, and the same query from Python (`ws.sql(...)`).

## Data permissions

Admins grant read access to `*` (everything), a catalog, a schema or a table. A grant goes to an email, to all editors, or to all viewers. Use "Permissions…" on a catalog, schema or table in the Data panel; only admins (`IARA_ADMIN_EMAILS`) see it.

- Grants are kept in `grants.json` in Studio's data folder (`IARA_STUDIO_DATA`, `/data` in Docker), out of reach of kernels on clusters.
- Without that file, editors read everything and viewers read nothing. Admins are never limited.
- The engine applies grants while it plans each query, so no query can get around them. A query that reads a table without a grant fails. Reading files directly (`read_parquet(...)`, `FROM 's3://...'`) and writing are refused.
- A grant on a view covers what the view reads.

Grants apply wherever Studio runs the query on someone's behalf:
- a dashboard, in the editor and when published: each viewer's own grants apply, and two viewers with different grants never share cached results;
- publishing: refused when a dataset reads a table the publisher has no grant on;
- Iara;
- the MCP server;
- the [ontology](#ontology): a term over a table you may not read is not shown to you.

They do not apply yet to notebooks, the SQL editor or the Data panel's previews: an editor running code there reads what the team bucket allows. With the Local cluster on, notebook code runs as Studio's user and can change `grants.json` itself.

## Iara (chat agent)

Iara is a chat panel in notebooks, in the SQL editor and in the dashboard editor. It answers questions about your data and writes or fixes cells, queries and dashboards.

In a dashboard the button is in the page's header, and Iara sees the whole dashboard. One proposal can add or change datasets, measures, relationships, charts, tables, filters and their places on the canvas; the panel lists its steps, and Apply writes them together. Iara then reads how the widgets draw, and proposes a fix when one that worked stops working. Table names and columns she reads are sent to OpenAI (requests are sent with `store: false`); rows are sent only when she runs a query on your behalf.

- **Reading:** Iara reads on its own, with your grants. It uses the same tools as the [MCP server](#mcp-server) (`list_tables`, `describe_table`, `explain_sql`, `run_sql`, `list_files`, `read_file`, `search_ontology`), called in-process. It is not exposed through MCP.
- **Changing:** every new or edited cell, every SQL edit and every run needs your approval. A proposal appears in the file as an inline diff with Keep and run, Keep and Reject. Nothing is written or saved until you keep it, and Undo after keeping reverts it. If the code changed since Iara read it, the proposal is refused; reject it and ask again.
- **Steps:** an analyst reads the data, an author writes the change, a reviewer checks it before you see it, and an observer reports what happened after you decide (rejected, applied, ran with an error). A run that failed goes back to the author for a fix, a limited number of times. The Steps list under each answer shows what was done.
- **Ontology:** when a question uses a business term or a metric, the analyst looks it up in the teams' [ontology](#ontology). The terms it read are listed under the answer, beside the ontology icon, with their team; a draft is marked as one. They are the terms the search gave, which is not always every term the answer used.
- **Memories:** Iara saves things you tell it to remember. They are kept per user, listed under Memories in the panel menu, and can be added or deleted there.
- **Conversations:** earlier conversations are kept and listed in the panel. The panel shows how many tokens the conversation has used.

Iara needs `OPENAI_API_KEY` (model `gpt-6-luna`; requests use `store: false`). Your questions, the code it reads, table names and columns, the ontology terms it finds, and the rows of the queries it runs (at most 500) are sent to OpenAI. Kernels never receive the key. Conversations and memories are kept in Studio's data folder, per user.

## Agents

An agent is an Iara focused on one subject. Agents are made in the Agents section and kept in the workspace as `agents/<name>/`: `agent.json` (name, description, tables with their notes, glossary), `instructions.md` and `examples.json` (example questions with their SQL). They are versioned with the workspace.

The builder has the test playground on the left, the open section in the middle, and a rail on the right with Instructions, Tables, SQL examples and Evaluations. Changes are saved as you type, and the next question in the playground uses them.

- **Instructions:** how the agent answers: rules, definitions, tone. Iara and the analyst both follow them. The Glossary tab maps the company's terms to their meaning; it belongs to the agent and is not written to a team's [ontology](#ontology). The Answer style tab sets the answers' language (the question's, Portuguese or English), their length, when to draw charts (when they help, whenever possible, never) and a tone.
- **Tables:** the tables you may read, by catalog and schema, with a checkbox on each table and on each schema. The agent reads only the checked tables, and of those only the ones the person asking may read; with none checked it reads nothing. Unchecking keeps the notes. Each table has a description and a description per column.
- **SQL examples:** questions people will ask, with the SQL that answers them. The analyst reuses and adapts that SQL when a question matches. Test query runs the SQL on the agent's checked tables and shows the first 20 rows.
- **Playground:** under each answer, the charts the agent drew, the SQL it ran (formatted), Save as example, and 👍/👎, which rate the answer in Evaluations. The example questions are offered above the input. An agent never changes files and keeps no memories.
- **Charts:** the agent draws a bar, line, area or pie chart from a query over its checked tables (at most 200 rows), when the answer style allows it.
- **Evaluations:** every question asked to the agent, with who asked it, how long it took and whether it was rated. The score is the share of good answers among the rated ones. Opening a question shows, in place of the playground, its answer, charts and SQL (queries that failed included), where it can be rated, noted, or its SQL saved as an example. The log is kept in Studio's data folder, outside the workspace, at most 1000 questions per agent.

The Agents page lists every agent with a search over names, descriptions and tables.

For now an agent is used only from its builder.

## MCP server

Studio serves the Model Context Protocol at `/api/mcp` (Streamable HTTP, JSON responses), so Claude Code, Cursor or another MCP client can read the catalog and query it. The tools only read:

| Tool | Does |
|---|---|
| `list_tables` | The tables you may read. |
| `describe_table` | Columns and row count of one of them. |
| `explain_sql` | The plan of a query, without running it. |
| `run_sql` | Runs one query: at most 500 rows, 30 seconds. |
| `list_files` | The workspace's notebooks, SQL files and text files. |
| `read_file` | The text of one of them (a notebook as its Python source). |
| `search_ontology` | What a business term means in the teams' [ontology](#ontology): its columns, its SQL and the joins between its tables. |

Only `run_sql` needs a cluster: it runs on its own kernel on the default cluster, with your grants. The other tools are answered by Studio. Each query must be a single SELECT: Studio wraps it as a subquery, so any other statement fails to parse.

With sign-in on, create a token under the account menu → "Connect an AI client…". The token is shown once:

```bash
claude mcp add --transport http iara https://studio-<team>.example.com/api/mcp --header "Authorization: Bearer <token>"
```

Tokens are kept as SHA-256 hashes in `tokens.json` in Studio's data folder, and can be revoked from the same dialog. A token stops working as soon as its email leaves `IARA_ALLOWED_EMAILS`; viewers cannot use the MCP server. With sign-in off, no token is needed.

## Ontology

The ontology is what the teams' business words mean in the data: a term, the columns it maps to, the SQL that computes it, and how tables join. Iara's analyst and the MCP server search it, so a question about "net revenue" is answered with the team's definition, not a guess.

Each team has one file, `<team>.toml` (lowercase letters, digits, `-` and `_`):

- team mode: objects under `_iara/ontology/` of `IARA_BUCKET`;
- local mode: files in the workspace's `.iara/ontology/` folder.

```toml
[ontology]
name = "Finance"
readers = ["editors"]          # or a list of emails
owners = ["ana@example.com"]   # Iara writes what they teach her into this file

[[term]]
name = "Net revenue"
description = "Revenue after discounts, before tax."
synonyms = ["receita líquida", "net sales"]
certified = true
columns = ["main.sales.orders.amount", "main.sales.orders.discount"]
sql = "sum(amount * (1 - discount))"

[[term]]
name = "Churned customer"
description = "A customer with no order in the last 90 days."
columns = ["main.sales.customers.id"]
tables = ["main.sales.orders"]   # tables the definition reads besides those of columns

[[join]]
left = "main.sales.orders.customer_id"
right = "main.sales.customers.id"
description = "Each order has one customer."
certified = true
```

- **Terms:** `name` and `description` are required. `columns` are written `catalog.schema.table.column`. A term with no column and no table is plain knowledge ("the fiscal year starts in April").
- **Drafts:** a term or join is a draft until it has `certified = true`. The analyst is told to use a certified definition as written and to check a draft against the data.
- **Who reads it:** `readers` lists emails, or `editors` (the default) for everyone who may use the Studio. Admins read every team's file. A term or join over a table you have no [grant](#data-permissions) on is left out for you, as if it did not exist. Like grants, this holds for Iara and the MCP server only: an editor running notebook code reads what the team bucket allows, these files included.
- **Editing:** write the files in the bucket or the folder; Iara itself only adds at their end what owners teach her (below). A change is picked up within a minute. A file with an unknown key or a bad name is not used at all, and admins are told why in the search's result; the other teams' files still work.

### How the ontology grows

There is no page to fill the ontology. Iara decides what goes into it while she talks with the people who own it: admins, for any team (they may start a new team's file), and the `owners` a file names, for that team.

1. When one of them states a lasting business rule of their team (what a term or metric means, how it is computed, which columns hold it, how two tables join), Iara writes it with `learn_ontology`, without asking, and says so in one line. One-off requests, personal preferences (those are [memories](#iara)) and her own guesses are not written.
2. The columns are checked against the tables that person may read: a column no table has is dropped, and so is a term left with none of the columns it named, and a join with a column that does not exist.
3. The rest is written at the end of the team's file with `certified = true`, under a comment with who taught it and the date. Nothing that was in the file changes. A term whose name the file already has (ignoring case and accents) and a join it already has are not written again; to change one, edit the file. In the team bucket the write is refused if the file changed meanwhile.

Everyone else's conversations never write to the ontology.

Search matches the words of the question with a term's name, synonyms, columns and description, ignoring case and accents. There are no embeddings: nothing but the question and the terms found is sent to the model.

## Dashboards

A dashboard is a canvas of datasets (one SQL query each) and widgets (charts or tables). The editor runs its queries with the signed-in user's grants. Publishing makes it available to viewers; a viewer opens it at `/view`, on the `IARA_VIEW_HOST` host when that is set, and that host serves nothing else. Two viewers with different grants never share cached results. "Schedule refresh" in the editor sets a cron schedule (UTC), stored as `[schedule]` (`cron`, `enabled`) in the dashboard's `dashboard.toml`. Each run renders the published dashboard's initial view (no filter values, no chart picks) on the dashboard's cluster, once for each set of read grants among the people who can open it. A viewer who opens the dashboard with no filters and no chart picks gets the stored render at once, with the time it was made, even when the cluster is stopped; filtered views still run live. Republishing or changing the grants ignores the stored renders until the next run. A run fails when the dashboard is not published or every widget failed, and keeps the previous renders. Refresh runs are not listed in Jobs. A scheduled refresh is skipped, and no cluster starts, when nothing it reads changed: every dataset is imported and was built from its current query, and each table it read is a Delta table still at the version it was read at. The run is recorded as succeeded, with "No source changed since the last refresh". A dataset that reads a table that is not Delta, or whose query depends on `now()`, `current_date` or `random()`, always refreshes; so do "Refresh now" and publishing. Publishing is refused when a dataset reads a table its publisher has no grant on.

Datasets are imported by default. Publishing, each scheduled run and "Refresh now" run the dataset once, with the publisher's grants, and store the result as a Parquet file under `_iara/extracts/<dashboard id>/` in the bucket (`.iara/extracts/` in the workspace without one). Renders read that copy in a kernel Studio runs itself, so filters and chart picks need no cluster. A viewer must have grants on every table the dataset read. A dataset with parameters of its own (`:name`), or with `-- iara:mode live` in its header (`"mode": "live"` in a recipe), runs on every render instead; the switch is in the editor's Data tab. While a dataset has no copy built from its current query, it runs live. A copy over `IARA_EXTRACT_MAX_MB` fails that dataset's refresh. With every dataset imported, runs store no initial-view render.

A dashboard's model is stored in its `model.py`, which the formula bar, Quick measure, the diagram and Iara write: measures, one per line, such as `revenue = sum(orders.o_totalprice)` or `margin = measure(divide(sum(orders.profit), sum(orders.o_totalprice)), format="percent")`. The file has Python syntax but is never run: the formula bar checks a measure as you type and completes names (Ctrl+Space), and Studio turns each measure into SQL. Datasets are available by name.

Select a chart to set it up. The Data tab of its settings has the visual and the fields; the Format tab has the rest.

| Visual | Data |
|---|---|
| Columns, bars (stacked or 100%), columns and line, line, area (stacked), heatmap, matrix, waterfall | X axis, Legend, Values |
| Pie, donut, treemap, funnel | X axis, Values |
| Card, gauge | Values (a gauge's second value is its maximum, unless Format sets one) |
| Scatter, histogram | Columns of one dataset |

X axis, Legend and Values each take a column of any dataset: drag it from the Fields pane, check its box there, or click the well's "Add" slot, which lists the fields by dataset and searches them. A column of another dataset is stored as `dataset.column`. A number goes to Values as a sum and anything else to the X axis, then to Legend. Click a value to change its name, its aggregation (sum, average, min, max, count, distinct count) and its number format. A value needs no line in `model.py`. Values also takes measures and "Rows", the row count of a dataset. Charts of categories have a sort and a "Show top" limit. A matrix has no totals. Waterfall's last column is the total of the steps.

Format sets the palette, a color per series or slice, the legend's position, axis titles, gridlines, smooth lines, data labels and the number format.

A table takes columns of the datasets its own dataset points at, also as `dataset.column`.

The Data tab holds the datasets and the measures. Its left side switches between them, each with a search; measures are grouped by the dataset they read first.

The Model tab shows the datasets and calendars as tables on a diagram. Drag a table by its title to place it (arrow keys move it too), and "Arrange" places them all again, facts on the left; the places are saved in the dashboard's `model_layout.json`. Drag a column onto a column of another table to relate them. A click on a line selects it, to remove it. N marks the many side and 1 the one side; a dashed line is a calendar's. "Relationships" there lists them and connects datasets without writing `model.py`. It suggests columns that look like the same key (`o_custkey` and `c_custkey`, `customer_id` and `customers.id`), or you pick any two. It reads both columns to find which has one row per value, and refuses when neither has. Adding a dataset opens that list, and so does using two datasets that nothing connects on the canvas. A chart reaches a column from the dataset of its values to the "one" side, not the other way: a sum of `orders` can be drawn by `customer.c_mktsegment`, a sum of `customer` by `orders.o_orderstatus` cannot.

The Fields pane on the canvas's right lists each dataset's columns and measures (ƒx), the calendar and the parameters. "+ Measure", here or in the Data tab's list of measures, or New measure in a dataset's menu, opens the formula bar: type `name = expression`, pick a number format, and confirm; the line is added to `model.py` and the measure to the selected chart. Clicking a measure's name, in either place or on a chart's Values, opens it in the bar. A format picked there for a measure that exists applies at once, without confirming. A measure's menu also renames it (in the model and in every chart that uses it) or deletes it. Quick measure writes the line from a template (sum of a column, % of total, year to date, change vs previous year, running total, rank, rolling total). Only a field's checkbox puts it on the selected chart or table or takes it off. A field can also be dragged onto a chart or table. Clicking the canvas outside a widget deselects it.

| Function | What it gives |
|---|---|
| `sum`, `avg`, `min`, `max`, `count`, `count_distinct`, `count_rows(dataset)` | an aggregation of one dataset's rows |
| `if_(cond, a, b)`, `switch(c1, v1, c2, v2, default=v)` | a choice, per row or over aggregations |
| `divide(a, b, alternate=None)` | `a / b`, empty (or `alternate`) when `b` is 0 or empty; `/` fails the chart instead |
| `measure(expr, format=, decimals=, currency=, compact=, label=)` | a measure with a number format and a label |
| `relate(many.column, one.column)` | a relationship |
| `calculate(m, filters…)`, `all_(dataset or dataset.column)` | `m` with filters added (a filter on a column replaces the dashboard's filter and the chart's grouping on it) or removed: `divide(m, calculate(m, all_(customer)))` is a share of the total |
| `dates = calendar(orders.o_orderdate, …)` | a dataset of dates (`date`, `year`, `quarter`, `month`, `week`, `month_of_year`, `day_of_week`) related to those columns; one per model |
| `ytd`, `qtd`, `mtd`, `previous_year`, `previous_period(m, unit)` | along a chart grouped by a calendar column, reading past the calendar's filters |
| `running_total(m)`, `rolling(m, n)`, `rank(m)` | along the chart's x: the total so far, the total of the last `n` values or periods, the rank (1 = highest) within each series |
| `rate = param("rate", 0.1)` | `:rate`, set by a dashboard parameter filter, else the default |

An aggregation reads one dataset; a measure can combine aggregations of several (`attainment = divide(sum(orders.total), sum(targets.value))`). A bar, line, area, pie or counter chart can draw measures instead of a column and an aggregation (Measures in the chart's settings), grouped by its dataset's columns or by a related dataset's column (`nation.n_name`).

`relate(orders.o_custkey, customer.c_custkey)` says each order points at one customer. A filter or a chart pick on `customer` then narrows `orders` and every widget on it, and further along a chain (`nation` → `customer` → `orders`); a filter on `orders` does not narrow `customer`. The relationships may not form a cycle, and two datasets have at most one path between them. A measure whose datasets do not reach the column a chart groups by repeats its total in every group, and the editor marks that chart with a note.

## Sign-in

Sign-in is off unless `IARA_AUTH=auth0` (or `AUTH0_DOMAIN` is set). With sign-in off, every visitor is an admin. With it on, the verified email decides the role: `IARA_ALLOWED_EMAILS` are editors, `IARA_VIEWER_EMAILS` are viewers (dashboards only), and `IARA_ADMIN_EMAILS` (among the editors) can manage data permissions. Unverified emails are refused. Auth0 needs `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET` and `APP_BASE_URL`.

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
| `OPENAI_API_KEY` | | Key for Iara (OpenAI API). Without it, she answers that the key is not set. |
| `IARA_AUTH` | off | `auth0` turns on sign-in (see [Sign-in](#sign-in)). |
| `IARA_ALLOWED_EMAILS` | | Editors, comma-separated. Used with sign-in on. |
| `IARA_VIEWER_EMAILS` | | Viewers, comma-separated: dashboards only. |
| `IARA_ADMIN_EMAILS` | | Admins, comma-separated: data permissions. |
| `IARA_VIEW_HOST` | | Bare hostname that serves only `/view`. |
| `IARA_EXTRACT_MAX_MB` | `100` | Largest imported dashboard dataset (Parquet size). |
| `IARA_STUDIO_DATA` | | Studio's data folder: grants, tokens, job runs and dashboard renders (`/data` in Docker). |
| `IARA_BUCKET` | | Team mode: the catalog and warehouse live in this bucket. |
| `IARA_STORAGE_ENDPOINT` | | S3 endpoint of the team bucket (empty for AWS S3). |
| `IARA_SCHEDULER` | on | `0` turns the job scheduler off. |
