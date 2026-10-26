---
title: Session Warehouse & DDL
description: Configuring table persistence and executing SQL DDL statements.
---

### How it works

The warehouse is a folder or an `s3://` prefix where `CREATE TABLE` puts its tables. By default each table is a Delta table: a folder of Parquet data files and a `_delta_log/` folder of commits. `USING PARQUET` makes a plain Parquet folder instead. Without a warehouse, created tables stay in memory, and `PARTITIONED BY` and `USING DELTA` are refused.

A write to a Delta table is a commit. The data files are written first, and one commit adds them to the log. The commit writes the next version file only if it does not exist yet, so two writers cannot take the same version: a commit that loses the race checks the newer versions and tries again. A statement that fails before its commit, such as a cast that fails on some row, leaves the table at its previous version, and its new files are not referenced by the log. Time travel reads an older version through the same log.

---

### Setting the Warehouse Location

#### `SessionContext.set_warehouse`
Configures where SQL `CREATE TABLE` writes its tables (a local path or an `s3://` prefix). Without a warehouse configured, created tables remain in memory. In a workspace, the warehouse is the `warehouse` folder of the workspace unless `[workspace] warehouse` in `iara.toml` names another. Setting the warehouse does not read the folder: tables already in it are known to the session only once they are created or registered in it.

```python
SessionContext.set_warehouse(
    path: str | os.PathLike[str] | None,
    storage_options: dict[str, Any] | None = None
) -> SessionContext
```

#### `SessionContext.warehouse`
Returns the active warehouse path string or `None`.

```python
SessionContext.warehouse -> str | None
```

`warehouse` is a property: read it without parentheses. It returns the path as it was given to `set_warehouse`.

#### `SessionContext.set_schema_location`
Sets the folder or prefix where `CREATE TABLE schema.name` writes its tables, instead of the warehouse. `schema` is `s` for the default catalog or `c.s` for another one. Passing `None` removes the location. A table's folder is `<path>/<name>/`.
```python
SessionContext.set_schema_location(
    schema: str,
    path: str | None,
    storage_options: dict[str, Any] | None = None
) -> SessionContext
```

---

### Where Tables Are Written

`CREATE TABLE` writes each table to its own folder, and the folder follows the table's name:

| Table | Folder |
|---|---|
| `orders` (`main` of the default catalog) | `<warehouse>/orders/` |
| `raw.events` (schema `raw` of the default catalog) | `<warehouse>/raw/events/` |
| `sales.main.orders` (catalog `sales`) | `<warehouse>/_catalogs/sales/main/orders/` |
| `sales.raw.events` (catalog `sales`) | `<warehouse>/_catalogs/sales/raw/events/` |

Here `sales` is a catalog other than the default one. Every catalog other than the default one is kept under `_catalogs`, `main` included.

A schema can have a location. Its tables are then written to `<location>/<table>/` instead, whatever the warehouse is. Set it with `SessionContext.set_schema_location(schema, path)`, or with `location` in a `[schemas.<name>]` section of `iara.toml` (`[catalogs.<c>.schemas.<name>]` for another catalog). `schema` is `s` in the default catalog or `c.s` in another one.

---

### SQL DDL & DML Commands

Iara SQL supports writing data and managing schemas. Writes to Delta tables are transactional (see How it works). A Parquet folder has no log, so a write there adds files, and an overwrite removes the old files once the new ones are written:

#### `CREATE TABLE ... AS SELECT`
Writes a Delta table to its folder (see Where Tables Are Written) and registers it. `USING PARQUET` writes plain Parquet files instead. Without a warehouse, the table is kept in memory. A name that already exists fails, unless `IF NOT EXISTS` (which then does nothing) or `OR REPLACE` is given. Example:
```sql
CREATE TABLE top_customers AS
SELECT c_custkey, c_name, c_acctbal
FROM customer
WHERE c_acctbal > 5000;
```

#### Partitioned Tables
Partitioning needs a warehouse: without one, `PARTITIONED BY` is refused.
```sql
CREATE TABLE sales_by_year
PARTITIONED BY (sale_year, region) AS
SELECT *, year(sale_date) AS sale_year, region
FROM raw_sales;
```

#### `INSERT INTO`
Appends the rows to an existing table: one commit for a Delta table, new Parquet files for a Parquet folder:
```sql
INSERT INTO top_customers
SELECT c_custkey, c_name, c_acctbal
FROM new_customers;
```

The columns are matched by position, or by the names in `INSERT INTO t (cols)`. Table columns that are not given get nulls. If the query fails, the table is unchanged. For a Delta table `orders` with one row, a cast that fails while the rows are written leaves it at one row:

```python
>>> ctx.sql("INSERT INTO orders SELECT CAST('abc' AS BIGINT) AS id, 'b' AS name").collect()
# raises IaraError: Arrow error: Cast error: Cannot cast string 'abc' to value of Int64 type
>>> ctx.sql("SELECT count(*) AS n FROM orders").collect().to_arrow().to_pylist()
[{'n': 1}]
```

#### `COPY ... TO`
Exports arbitrary query results to Parquet or CSV:
```sql
COPY (SELECT * FROM orders WHERE o_orderdate >= date '2026-01-01')
TO 's3://my-bucket/exports/2026_orders'
(FORMAT parquet, PARTITION_BY (o_orderstatus));
```

`COPY` writes the rows of the query to a file or a folder. The format comes from `FORMAT`, or else from the extension: `.csv`, `.json`, `.ndjson` or `.jsonl`, and Parquet otherwise. A path ending in `/` (or an existing local directory) is a folder, and so is a partitioned write. A folder gets new files. If it already holds files, `OVERWRITE true` is required, and the old files are removed once the new ones are written. Any other path is written as one file. S3 paths use the storage options set for their prefix. `PARTITION_BY` works for Parquet only.

#### `DROP TABLE` & `DROP SCHEMA`
```sql
DROP TABLE top_customers;
DROP SCHEMA sales CASCADE;
```

`DROP TABLE` deletes the folder of a Delta table that `CREATE TABLE` wrote to the warehouse or to a schema location. Other tables are only removed from the session, and their data is kept. `DROP SCHEMA ... CASCADE` removes the schema's tables from the session, and their files stay. Without `CASCADE`, `DROP SCHEMA` fails while the schema holds tables, and `DROP CATALOG` follows the same rule.

`UPDATE`, `DELETE`, `MERGE`, `OPTIMIZE`, `VACUUM` and `RESTORE` on Delta tables are described in `docs/delta.md` in the repository.
