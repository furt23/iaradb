---
title: Session Warehouse & DDL
description: Configuring table persistence and executing SQL DDL statements.
---

### Setting the Warehouse Location

#### `SessionContext.set_warehouse`
Configures where SQL `CREATE TABLE` writes its tables (a local path or an `s3://` prefix). Without a warehouse configured, created tables remain in memory. In a workspace, the warehouse is the `warehouse` folder of the workspace unless `[workspace] warehouse` in `iara.toml` names another.

```python
SessionContext.set_warehouse(
    path: str | os.PathLike[str] | None,
    storage_options: dict[str, Any] | None = None
) -> SessionContext
```

#### `SessionContext.warehouse`
Returns the active warehouse path string or `None`.

```python
SessionContext.warehouse() -> str | None
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

Iara SQL supports writing data and managing schemas transactionally:

#### `CREATE TABLE ... AS SELECT`
Writes a Delta table to its folder (see Where Tables Are Written) and registers it. `USING PARQUET` writes plain Parquet files instead. Example:
```sql
CREATE TABLE top_customers AS
SELECT c_custkey, c_name, c_acctbal
FROM customer
WHERE c_acctbal > 5000;
```

#### Partitioned Tables
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

#### `COPY ... TO`
Exports arbitrary query results to Parquet or CSV:
```sql
COPY (SELECT * FROM orders WHERE o_orderdate >= date '2026-01-01')
TO 's3://my-bucket/exports/2026_orders'
(FORMAT parquet, PARTITION_BY (o_orderstatus));
```

#### `DROP TABLE` & `DROP SCHEMA`
```sql
DROP TABLE top_customers;
DROP SCHEMA sales CASCADE;
```

`DROP TABLE` deletes the folder of a Delta table that `CREATE TABLE` wrote to the warehouse or to a schema location. Other tables are only removed from the session, and their data is kept. `DROP SCHEMA ... CASCADE` removes the schema's tables from the session, and their files stay.
