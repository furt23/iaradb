---
title: Session Warehouse & DDL
description: Configuring table persistence and executing SQL DDL statements.
---

### Setting the Warehouse Location

#### `SessionContext.set_warehouse`
Configures where SQL `CREATE TABLE ... AS SELECT` writes Parquet datasets (a local path or an `s3://` prefix). Without a warehouse configured, created tables remain in memory.

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

---

### SQL DDL & DML Commands

Iara SQL supports writing data and managing schemas transactionally:

#### `CREATE TABLE ... AS SELECT`
Writes Parquet partitions to `<warehouse>/<table_name>/` and registers the table:
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
Appends new Parquet partition files to an existing table:
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
