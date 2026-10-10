---
title: Quickstart Guide
description: Get up and running with Workhouse Python API in minutes.
---

This guide introduces the core concepts of the Workhouse Python API: constructing queries, evaluating expressions, running SQL, and exporting results.

## Installation

Install Workhouse into your Python environment:

```bash
pip install workhouse
```

Import the package and commonly used expression utilities:

```python
import workhouse as wh
from workhouse import col, lit
```

---

## 1. Creating DataFrames

You can construct Workhouse DataFrames in memory from Python dictionaries or existing Arrow/Pandas/Polars objects.

```python
>>> data = {
...     "id": [1, 2, 3, 4],
...     "dept": ["Eng", "Sales", "Eng", "Sales"],
...     "salary": [120000.0, 95000.0, 140000.0, 80000.0],
... }
>>> df = wh.from_dict(data)
>>> df.show()
┌─────┬───────┬──────────┐
│ id  │ dept  │ salary   │
│ i64 │ utf8  │ f64      │
├─────┼───────┼──────────┤
│ 1   │ Eng   │ 120000.0 │
│ 2   │ Sales │ 95000.0  │
│ 3   │ Eng   │ 140000.0 │
│ 4   │ Sales │ 80000.0  │
└─────┴───────┴──────────┘
```

---

## 2. Lazy Execution with LazyFrame

Workhouse uses a lazy-first evaluation model. Query chains built with `LazyFrame` do not compute immediately; they construct an optimized logical plan that executes only when `.collect()` or a streaming sink is invoked.

```python
>>> lf = df.lazy()
>>> filtered = (
...     lf.filter(col("salary") >= 100000.0)
...     .select(
...         col("id"),
...         col("dept"),
...         (col("salary") * 1.10).alias("bonus_salary")
...     )
...     .sort("bonus_salary", descending=True)
... )
>>> result = filtered.collect()
>>> result.show()
┌─────┬──────┬──────────────┐
│ id  │ dept │ bonus_salary │
│ i64 │ utf8 │ f64          │
├─────┼──────┼──────────────┤
│ 3   │ Eng  │ 154000.0     │
│ 1   │ Eng  │ 132000.0     │
└─────┴──────┴──────────────┘
```

---

## 3. Grouping and Aggregations

Group by one or more columns and compute summary statistics using `group_by()`:

```python
>>> summary = (
...     df.lazy()
...     .group_by("dept")
...     .agg(
...         headcount=wh.len(),
...         avg_salary=col("salary").mean(),
...         max_salary=col("salary").max(),
...     )
...     .sort("avg_salary", descending=True)
...     .collect()
... )
>>> summary.show()
┌───────┬───────────┬────────────┬────────────┐
│ dept  │ headcount │ avg_salary │ max_salary │
│ utf8  │ u64       │ f64        │ f64        │
├───────┼───────────┼────────────┼────────────┤
│ Eng   │ 2         │ 130000.0   │ 140000.0   │
│ Sales │ 2         │ 87500.0    │ 95000.0    │
└───────┴───────────┴────────────┴────────────┘
```

---

## 4. Querying with SQL

Execute standard ANSI SQL queries against frames or registered tables using `wh.sql()`:

```python
>>> sql_result = wh.sql("""
...     SELECT dept, count(*) as count, sum(salary) as total_payroll
...     FROM employees
...     WHERE salary > 90000
...     GROUP BY dept
... """, employees=df).collect()
>>> sql_result.show()
┌───────┬───────┬───────────────┐
│ dept  │ count │ total_payroll │
│ utf8  │ u64   │ f64           │
├───────┼───────┼───────────────┤
│ Eng   │ 2     │ 260000.0      │
│ Sales │ 1     │ 95000.0       │
└───────┴───────┴───────────────┘
```

---

## 5. Reading and Writing Parquet Files

Scan and write Parquet files locally or over `s3://` URLs:

```python
# Lazily scan files matching a glob pattern
lf = wh.scan_parquet("data/transactions/*.parquet")

# Process and stream directly to output files without holding full data in memory
row_count = lf.filter(col("status") == "COMPLETED").sink_parquet("data/completed_transactions.parquet")
print(f"Wrote {row_count} rows.")
```

---

## 6. Zero-Copy Interoperability

Export materialized results directly to standard data science formats through the Arrow C Stream protocol:

```python
# Convert to PyArrow Table
arrow_table = result.to_arrow()

# Convert to Pandas DataFrame
pandas_df = result.to_pandas()

# Convert to Polars DataFrame
polars_df = result.to_polars()
```
