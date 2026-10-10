# Test Report: Workhouse Studio (Round of 2026-10-09)

**Date**: 2026-10-09  
**Target**: Workhouse Studio (`http://localhost:3873`, viewport 1440×900)  
**Configuration**:
- `WORKHOUSE_WORKSPACE`: `%TEMP%\wh-test-ws`
- `WORKHOUSE_STUDIO_DATA`: `%TEMP%\wh-test-studio`
- `WORKHOUSE_LOCAL_COMPUTE`: `1`
- `WORKHOUSE_AWS_ENV_FILE`: `%TEMP%\wh-no-aws`
- `NEXT_DIST_DIR`: `.next-gemini`

---

## Summary of Results

| # | Test Area | Status | Evidence |
|---|---|:---:|---|
| 1 | **Sidebar** (Collapse with «, Reload persistence, Expand with ») | **PASS** | [sidebar_collapsed.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/sidebar_collapsed.png), [sidebar_after_reload.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/sidebar_after_reload.png), [sidebar_expanded.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/sidebar_expanded.png) |
| 2 | **Notebook ID in URL** (`/notebooks/<8-char-id>`, rename persistence) | **PASS** | [notebook_opened.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/notebook_opened.png), [notebook_renamed.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/notebook_renamed.png) |
| 3 | **Cluster Dropdown** (Current cluster card, Running group, Create disabled, Manage) | **PASS** | [cluster_dropdown.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/cluster_dropdown.png) |
| 4 | **Kernel Menu** (Run all, Restart & Stale dot, Clear all outputs & reload, Single cell clear) | **PASS** | [kernel_after_restart_stale.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/kernel_after_restart_stale.png), [kernel_clear_all_after_reload.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/kernel_clear_all_after_reload.png), [cell_single_cleared.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/cell_single_cleared.png) |
| 5 | **File Menu** (Download .ipynb, Download .md, Move to…, Duplicate, Delete confirmation) | **PASS** | [move_dialog.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/move_dialog.png), [file_duplicate.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/file_duplicate.png), [delete_dialog.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/delete_dialog.png) |
| 6 | **Cell Link** (Copy link, New tab scroll & highlight, `@app.cell(id=...)` in .py) | **PASS** | [cell_link_verified.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/cell_link_verified.png) |
| 7 | **Outline** (Markdown headings tree, Scroll to heading, Variables panel) | **PASS** | [outline_panel.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/outline_panel.png), [outline_scrolled_to_heading.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/outline_scrolled_to_heading.png), [variables_panel.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/variables_panel.png) |
| 8 | **Schemas** (`create schema`, `create table`, tree & TOML sync, New schema dialog, Cascade drop) | **PASS** | [data_sales_schema.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/data_sales_schema.png), [new_schema_dialog.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/new_schema_dialog.png), [add_table_dialog.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/add_table_dialog.png), [data_after_drop_schema.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/data_after_drop_schema.png) |
| 9 | **Analyze** (Query execution, `/analyze/<id>` cards & graph, drawer, tabs, list & history button) | **PASS** | [analyze_page.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/analyze_page.png), [analyze_drawer.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/analyze_drawer.png), [analyze_pipelines_tab.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/analyze_pipelines_tab.png), [analyze_plantext_tab.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/analyze_plantext_tab.png), [analyze_list.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/analyze_list.png), [query_history.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/query_history.png) |
| 10 | **Compute** (`/compute` summary cards, `/compute/local` detail tabs: Overview, Kernels with Restart/Stop, Notebooks, Event log) | **PASS** | [compute_index.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/compute_index.png), [compute_local.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/compute_local.png), [compute_local_kernels_tab.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/compute_local_kernels_tab.png) |

---

## Detailed Test Breakdown

### 1. Sidebar
- **Collapse with `«`**: Clicked collapse button at bottom-left (`button[aria-label*="Collapse rail"]`). Sidebar narrowed from 240px to icon rail (56px). Text labels disappeared, leaving only navigation icons.
  - **Result**: **PASS** ([sidebar_collapsed.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/sidebar_collapsed.png))
- **Reload Persistence**: Reloaded page (`page.reload()`). Nav rail remained collapsed at 56px (state persisted in client storage).
  - **Result**: **PASS** ([sidebar_after_reload.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/sidebar_after_reload.png))
- **Expand with `»`**: Clicked expand button (`button[aria-label*="Expand rail"]`). Nav rail expanded back to 240px.
  - **Result**: **PASS** ([sidebar_expanded.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/sidebar_expanded.png))

### 2. Notebook ID in URL
- **Open `notebooks/tpch_tour.py`**: Selected file in workspace tree. Landed on URL `http://localhost:3873/notebooks/12yd3sx9` matching `/notebooks/<8 characters>`.
  - **Result**: **PASS** ([notebook_opened.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/notebook_opened.png))
- **Rename File in Tree**: Opened `…` context menu on tree item, selected "Rename…", changed name to `tpch_tour_renamed.py`. URL remained unchanged (`/notebooks/12yd3sx9`) while workbench tab title updated to `tpch_tour_renamed.py`.
  - **Result**: **PASS** ([notebook_renamed.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/notebook_renamed.png))

### 3. Cluster Dropdown in Notebook Header
- **Cluster Header Menu**: Clicked cluster picker button in notebook top bar (`button:has-text("Local")`).
  - Dropdown displayed card for current cluster with **Local**, **Running**, and "this machine".
  - Displayed "Running" group heading with selected item checkmark.
  - Displayed "Create cluster…" option, properly disabled with secondary subtitle *"AWS not configured"*.
  - Displayed "Manage clusters…" button.
  - **Result**: **PASS** ([cluster_dropdown.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/cluster_dropdown.png))

### 4. Kernel Menu
- **Run all & Restart**: Created test notebook `test_kernel_ops.py` with print output cells. Clicked "Run all" (output rendered), followed by **Kernel → Restart**. Outputs remained visible and were marked stale with an amber status badge (`bgcolor: rgb(245, 196, 107)`, tooltip *"edited since the last run"*).
  - **Result**: **PASS** ([kernel_after_restart_stale.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/kernel_after_restart_stale.png))
- **Clear All Outputs**: Selected **Kernel → Clear all outputs**. All output panels disappeared. Reloaded the page; outputs remained cleared.
  - **Result**: **PASS** ([kernel_clear_all_after_reload.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/kernel_clear_all_after_reload.png))
- **Single Cell Clear**: Ran cells again. Selected single cell's `⋮` menu → "Clear output". Only the selected cell's output was cleared; the adjacent cell's output remained intact.
  - **Result**: **PASS** ([cell_single_cleared.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/cell_single_cleared.png))

### 5. File Menu
- **Download .ipynb**: Clicked File → "Download as .ipynb". Intercepted browser download; file was validated as valid JSON with `"nbformat": 4`.
  - **Result**: **PASS**
- **Download .md**: Clicked File → "Download as .md". File downloaded successfully with valid markdown representations of notebook cells.
  - **Result**: **PASS**
- **Duplicate**: Clicked File → "Duplicate". New tab opened with copy `test_kernel_ops_copy.py`.
  - **Result**: **PASS** ([file_duplicate.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/file_duplicate.png))
- **Move to…**: Clicked File → "Move to…". Destination dialog opened with folder tree. Selected root folder `/`, confirmed move. Verified file moved to workspace root on disk.
  - **Result**: **PASS** ([move_dialog.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/move_dialog.png), [after_moved.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/after_moved.png))
- **Delete…**: Clicked File → "Delete…". Dialog popped up prompting for confirmation with warning text and Cancel / Delete buttons.
  - **Result**: **PASS** ([delete_dialog.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/delete_dialog.png))

### 6. Cell Link
- **Copy Link to Cell**: In cell `⋮` menu, clicked "Copy link to cell". Clipboard received `http://localhost:3873/notebooks/12yd3sx9#cell-d4yo0bm0`.
- **Open in New Tab**: Opened link in new tab. Window smoothly scrolled to targeted cell `d4yo0bm0` and applied highlight box shadow (`border-color: #2563eb`).
- **Disk File Verification**: Checked Python file on disk; cell was persisted with decorator `@app.cell(id="d4yo0bm0")`.
  - **Result**: **PASS** ([cell_link_verified.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/cell_link_verified.png))

### 7. Outline
- **Headings Tree**: Added markdown cell containing:
  ```markdown
  # 1 Intro
  ## 1.1 Details
  # 2 Results
  ```
  Clicked "Outline" button in toolbar. Outline side panel rendered hierarchy:
  - `1 Intro`
    - `1.1 Details` (nested with indent)
  - `2 Results`
  - **Result**: **PASS** ([outline_panel.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/outline_panel.png))
- **Click to Scroll**: Clicked `2 Results` in outline tree; editor automatically scrolled the viewport to the heading.
  - **Result**: **PASS** ([outline_scrolled_to_heading.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/outline_scrolled_to_heading.png))
- **Variables Tab**: Switched side panel tab to "Variables". Displayed defined notebook variables (`my_var: int = 12345`).
  - **Result**: **PASS** ([variables_panel.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/variables_panel.png))

### 8. Schemas
- **Create Schema**: In SQL Editor, executed `create schema sales`. Executed successfully.
- **Create Table As Select**: Executed `create table sales.top as select n_name from nation`. Query returned successfully.
- **Data Section Tree**: Navigated to `/data`. Tree displayed schema node `sales` containing table node `top`.
  - **Result**: **PASS** ([data_sales_schema.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/data_sales_schema.png))
- **`workhouse.toml` Persistence**: Verified workspace `workhouse.toml` on disk; contained `[schemas.sales]` and `[tables.sales.top]`.
- **Panel Actions**:
  - Clicked "New schema…" button in panel → dialog opened.
  - Clicked "…" on schema → "Add table here…" → dialog opened.
  - **Result**: **PASS** ([new_schema_dialog.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/new_schema_dialog.png), [add_table_dialog.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/add_table_dialog.png))
- **Drop Schema Cascade**: In SQL Editor, executed `drop schema sales cascade`. Schema `sales` and table `top` were removed from catalog tree in `/data` and removed from `workhouse.toml`.
  - **Result**: **PASS** ([data_after_drop_schema.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/data_after_drop_schema.png))

### 9. Analyze
- **Run Query & Click Analyze**: In SQL Editor, entered:
  ```sql
  select n_name, count(*) from customer join nation on c_nationkey = n_nationkey group by n_name
  ```
  Clicked "Analyze" button.
- **Landed on `/analyze/<id>`**:
  - Summary cards: **Total time** (`513 µs`), **Rows** (`25`), **Peak memory** (`3.8 KB`), **Pipelines** (`2`).
  - Execution graph rendered with boxes displaying row counts and operator timings.
  - Clicked operator box (`AggregateExec`) → right drawer opened showing operator details, timing, output rows, and schema.
  - Tabs **Pipelines** (pipeline diagrams with wall-clock timing bars) and **Plan text** (formatted physical plan) rendered properly.
  - **Result**: **PASS** ([analyze_page.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/analyze_page.png), [analyze_drawer.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/analyze_drawer.png), [analyze_pipelines_tab.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/analyze_pipelines_tab.png), [analyze_plantext_tab.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/analyze_plantext_tab.png))
- **Analysis Index (`/analyze`)**: Listed all query analyses with timestamps and query summaries.
  - **Result**: **PASS** ([analyze_list.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/analyze_list.png))
- **Query History (`/history`)**: Listed executed queries with an "Analyze" button on each row linking to plan analysis.
  - **Result**: **PASS** ([query_history.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/query_history.png))

### 10. Compute
- **Compute Dashboard (`/compute`)**:
  - Summary metric cards displayed at top: Running Clusters, Monthly Cost estimate, Attached Notebooks count.
  - Cluster list displayed Local cluster with state "Running".
  - **Result**: **PASS** ([compute_index.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/compute_index.png))
- **Cluster Detail (`/compute/local`)**:
  - Clicked "Local" row → navigated to `/compute/local`.
  - Rendered tabs: **Overview**, **Kernels**, **Notebooks**, and **Event log**.
  - **Kernels** tab listed active notebook kernels with **Restart** and **Stop** action buttons.
  - **Result**: **PASS** ([compute_local.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/compute_local.png), [compute_local_kernels_tab.png](file:///C:/Users/furta/.gemini/antigravity-ide/brain/88034087-ff26-4e8a-b469-626a0e2378f6/screenshots/compute_local_kernels_tab.png))

---

## Visual & UX Observations

1. **Toolbar Tooltip Overlap**: Clicking the "Outline" button in the notebook toolbar leaves the browser button tooltip ("Outline") visible directly above the "Variables" toggle in the newly opened side panel until the pointer moves away.
2. **Dark Theme Quality**: Dark mode theme contrast, borders, and typography (JetBrains Mono Variable for code/tables, Inter for UI) remain clean and consistent across all screens without truncated labels or layout jitter.

---

## Teardown Verification

- Test server on port 3873: **Stopped**
- Temporary directory `apps/web/.next-gemini`: **Deleted**
- `apps/web/tsconfig.json`: **Reverted** (`git diff apps/web/tsconfig.json` is clean)
