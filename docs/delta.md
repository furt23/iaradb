# Delta Lake tables

Iara reads and writes Delta Lake tables without the `deltalake` crates. A Delta table is a folder with a `_delta_log/` of commits. Other tools that read Delta can read these tables, and the reverse.

Tables created in a warehouse are Delta by default. Plain Parquet folders are still available with `USING PARQUET`.

## Creating tables

```sql
CREATE TABLE sales.orders (id bigint NOT NULL, region text, amount double) PARTITIONED BY (region);
CREATE TABLE sales.daily AS SELECT region, sum(amount) AS total FROM sales.orders GROUP BY region;
CREATE TABLE raw.events (id bigint, payload text) USING PARQUET;
CREATE OR REPLACE TABLE sales.daily AS SELECT ...;
```

- `CREATE TABLE` without `OR REPLACE` fails when the table exists.
- `NOT NULL` is kept in the table schema.
- `PARTITIONED BY` needs a warehouse. Without one, the table is kept in memory.
- Delta tables are written to the warehouse folder of the workspace (`warehouse` by default, see [studio.md](studio.md#catalog)).

## Writing rows

| Statement | Effect |
|---|---|
| `INSERT INTO t [(cols)] query` | Appends the rows in one commit. |
| `INSERT OVERWRITE t query` | Replaces every row in one commit. The old files stay for time travel. |
| `TRUNCATE TABLE t` | Removes every row in one commit. The history stays. |
| `CREATE OR REPLACE TABLE t AS query` | Replaces the table. |

The data files are written first and added by one commit. If the query fails, the table is unchanged.

### UPDATE, DELETE and MERGE

```sql
UPDATE t [AS a] SET c = expr, ... [WHERE pred];
DELETE FROM t [AS a] [WHERE pred];

MERGE INTO t [AS a] USING (query) | table [AS s] ON cond
  WHEN MATCHED [AND c] THEN UPDATE SET c = expr, ... | UPDATE SET * | DELETE
  WHEN NOT MATCHED [BY TARGET] [AND c] THEN INSERT [(cols)] VALUES (...) | INSERT *
  WHEN NOT MATCHED BY SOURCE [AND c] THEN DELETE | UPDATE SET c = expr, ...;
```

`UPDATE SET *` copies every column of the source row. `INSERT *` inserts every column of the source row. `WHEN NOT MATCHED BY SOURCE` applies to target rows with no matching source row. It cannot use `UPDATE SET *`, because there is no source row.

The result is one row: `rows`, `version`, `files_removed` and `files_added`.

## Time travel

```sql
SELECT * FROM sales.orders VERSION AS OF 3;
SELECT * FROM sales.orders TIMESTAMP AS OF '2026-10-01 12:00:00';
SELECT * FROM read_delta('s3://my-bucket/orders', version => 3);
```

```python
iara.read_delta("warehouse/sales/orders", version=3)
iara.scan_delta("warehouse/sales/orders", timestamp="2026-10-01 12:00:00")
```

Time travel needs a Delta table. On another format it is refused.

## Maintenance

```sql
DESCRIBE HISTORY sales.orders [LIMIT 20];     -- one row per commit
DESCRIBE DETAIL sales.orders;                 -- one row: the table's details
OPTIMIZE sales.orders [WHERE region = 'EU'];  -- compacts small files
VACUUM sales.orders [RETAIN 168 HOURS] [DRY RUN] [FORCE];
RESTORE TABLE sales.orders TO VERSION AS OF 3;
RESTORE TABLE sales.orders TO TIMESTAMP AS OF '2026-10-01 12:00:00';
```

- `VACUUM` deletes unneeded files older than the retention period. The default retention is 7 days (168 hours).
- A retention under 168 hours is refused unless `FORCE` is given. A short retention can break time travel and readers that are still on an older version.
- `DRY RUN` lists the files without deleting them.
- `RESTORE` writes a new commit that makes the table match an older version. The history is kept.

## Schema and properties

```sql
ALTER TABLE sales.orders ADD COLUMNS (channel text, discount double);
ALTER TABLE sales.orders SET TBLPROPERTIES ('owner' = 'finance');
ALTER TABLE sales.orders UNSET TBLPROPERTIES IF EXISTS ('owner');
```

`ALTER TABLE ... RENAME COLUMN` is refused. Delta stores column names in the data files, so a rename needs column mapping, which is not supported.

An overwrite keeps the table's schema and partitioning. `schema_mode="merge"` (Python) adds the new columns of the query to the table on append or overwrite.

## Dropping tables

`DROP TABLE` deletes the folder of a managed Delta table: one registered at the folder `CREATE TABLE` gives its name in the warehouse, or in its schema's location. Any other table is only removed from the catalog. The data is kept.

`TRUNCATE` keeps the table and its history.

## Python

```python
lf = iara.scan_delta("warehouse/sales/orders", version=None)
df = iara.read_delta("warehouse/sales/orders", version=3)

lf.sink_delta("warehouse/sales/daily", mode="overwrite", partition_by=["region"])
df.write_delta("warehouse/sales/copy", mode="append", schema_mode="merge")
```

`sink_delta` takes `mode`: `"error"` (default, the table must not exist), `"append"`, `"overwrite"` or `"ignore"` (no write when the table exists). It returns `{"version", "files", "rows", "skipped"}`.

`iara.storage.delta_history(path)` and `iara.storage.delta_info(path)` return the commit list and the table details that `DESCRIBE HISTORY` and `DESCRIBE DETAIL` show.

## Limits

These Delta features are not supported. A table that uses one fails to open with an error:

- deletion vectors;
- column mapping (`delta.columnMapping.mode`);
- v2 checkpoints.

## Commits and concurrency

A commit writes the next `_delta_log/<version>.json` only if the file does not exist yet, so two writers cannot take the same version. A commit that loses the race checks the newer versions and tries again.

Object stores without conditional writes cannot do this. For those, set the storage option `single_writer` to `true`. The engine then checks for the file and writes it, in two steps. Use it only when one process writes to the table.

```python
iara.set_storage_options("s3://my-bucket", {"single_writer": "true"})
```

Checkpoints are written after every 10 commits (versions 10, 20, ...), so readers do not replay the whole log.

## Interoperability

`tests/test_delta_interop.py` checks tables in both directions with `deltalake` (delta-rs), Polars and DuckDB. The DuckDB test is skipped when its Delta extension cannot be loaded (no network).

## Tests

```bash
pytest tests/test_sql_delta.py tests/test_sql_delta_dml.py tests/test_delta_interop.py
```
