# Test brief: Studio round of 2026-10-09

You are testing Workhouse Studio, a Next.js web app for interactive analytics and notebooks.
- **Don't edit the code.** Just test and report.
- **Only use the URL below.** Never touch port 3870, which is the user's own server.

## Setup
1. The repo is `C:\Users\furta\Projects\workhouse_engine`.
2. Copy `examples/workspace` to a temporary folder, for example `%TEMP%\wh-test-ws`. Skip `data/tpch_sf10`, `.workhouse` and `exports`, because they are large or local.
3. In `apps/web`, start a test server with these environment variables:
   - `WORKHOUSE_WORKSPACE=<that folder>`
   - `WORKHOUSE_STUDIO_DATA=%TEMP%\wh-test-studio`
   - `WORKHOUSE_LOCAL_COMPUTE=1`
   - `WORKHOUSE_AWS_ENV_FILE=%TEMP%\wh-no-aws`
   - `NEXT_DIST_DIR=.next-gemini`

   Then run: `pnpm exec next dev --port 3873`
4. Open http://localhost:3873 at about 1440×900.
5. When you finish:
   - stop the server;
   - delete `apps/web/.next-gemini`;
   - undo any change that `next dev` made to `apps/web/tsconfig.json` (`git checkout apps/web/tsconfig.json`).

## What to test (the expected result is after each →)
1. **Sidebar.**
   - Collapse it with the « button at the bottom left → only icons are left.
   - Reload → it stays collapsed.
   - Expand it again with ».
2. **Notebook id in the URL.**
   - Open `notebooks/tpch_tour.py` → the URL is `/notebooks/<8 characters>`.
   - Rename the file in the tree (its "…" menu) → the URL does not change, and the tab follows the new name.
3. **Cluster dropdown** in the notebook header → it shows a card for the current cluster (Local, Running), a "Running" group, "Create cluster…" (disabled, "AWS not configured") and "Manage clusters…".
4. **Kernel menu.**
   - Click Run all, then Kernel → Restart → the outputs stay, marked stale (an amber dot).
   - Kernel → Clear all outputs → the outputs disappear, and they stay gone after a reload.
   - A single cell's "⋮" menu → Clear output clears only that cell.
5. **File menu.**
   - Download .ipynb → the file opens as JSON with `"nbformat": 4`.
   - Download .md works.
   - Move to… moves the notebook to another folder.
   - Duplicate opens the copy.
   - Delete… asks for confirmation.
6. **Cell link.**
   - A cell's "⋮" → Copy link to cell.
   - Open that link in a new tab → it scrolls to that cell and highlights it.
   - The `.py` file now has `@app.cell(id="...")`.
7. **Outline.**
   - Add a markdown cell with this text:
     ```
     # 1 Intro
     ## 1.1 Details
     # 2 Results
     ```
   - The "Outline" button in the toolbar → a tree: 1 Intro > 1.1 Details, and 2 Results.
   - Clicking an item scrolls to its heading.
   - The Variables tab lists the variables.
8. **Schemas.**
   - In the SQL editor, run `create schema sales`.
   - Then run `create table sales.top as select n_name from nation`.
   - The Data section → the tree has a `sales` schema node containing `top`.
   - `workhouse.toml` in the workspace now has `[schemas.sales]` and `[tables.sales.top]`.
   - Use "New schema…" in the panel, and "Add table here…" on a schema.
   - `drop schema sales cascade` → the schema and its table leave the tree.
9. **Analyze.**
   - In the SQL editor, run `select n_name, count(*) from customer join nation on c_nationkey = n_nationkey group by n_name`.
   - Click "Analyze" → you land on `/analyze/<id>` with:
     - cards for total time, rows (25), memory and pipelines;
     - a graph whose boxes show rows and time;
     - a drawer with details when you click a box;
     - the Pipelines and Plan text tabs.
   - `/analyze` lists the analysis.
   - Query history has an Analyze button on each row.
10. **Compute.**
    - Click "Local" on `/compute` → `/compute/local`, with the tabs Overview, Kernels (the open notebooks' kernels, with Restart and Stop), Notebooks and Event log.
    - `/compute` shows summary cards at the top.

## Report back
For each item, give:
- PASS or FAIL;
- for a FAIL: what you did, what you expected, what happened, a screenshot, and any errors from the browser console and the server terminal.

Also list any visual problem you notice: cut-off text, overlaps, broken dark theme.
