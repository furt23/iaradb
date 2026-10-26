---
title: Quickstart Guide
description: Get up and running with Iara Python API in minutes.
---

This guide introduces the core concepts of the Iara Python API: constructing queries, evaluating expressions, running SQL, and exporting results.

## Installation

Use [uv](https://docs.astral.sh/uv/) to manage the environment and install Iara:

```bash
uv add iara
```

Outside a uv project, install it into the active environment with `uv pip install iara`.

Import the package and commonly used expression utilities:

```python
import iara
from iara import functions as F
```

---

## How it works

A `DataFrame` holds a materialized result: its columns are Arrow record batches in memory. A `LazyFrame` holds a plan. Each of its methods (`filter`, `select`, `group_by(...).agg`, `sort`, `join`, and so on) adds a step and returns a new `LazyFrame` without reading any data. The plan runs when it is collected into memory with `collect()`, or when a sink such as `sink_parquet()` writes it out. Before it runs, the optimizer rewrites the plan: it folds constant expressions and simplifies boolean logic, pushes filters down toward the scans, and drops the columns no step uses. A sort followed by a limit becomes a top-K. `explain()` shows the plan that will run.

The `DataFrame` methods (`filter`, `select`, `sort`, `group_by`, `join`, `sql`) are shorthand: each calls the matching `LazyFrame` method on `lazy()` and collects the result at once.

Aggregates ignore nulls: `sum`, `mean`, `min` and `max` skip null values, and a group whose values are all null gives null. `count()` counts the non-null values of a column and `len()` counts rows. A null group key forms a group of its own. `sort` puts nulls first unless `nulls_last=True`, in either direction. The row order of `group_by` output is not defined, so sort the result when the order matters.

---

## 1. Creating DataFrames

You can construct Iara DataFrames in memory from Python dictionaries or existing Arrow/Pandas/Polars objects. `from_dict` copies the values into the engine. Each list becomes a column whose type is inferred from its values (`Int64`, `Float64`, `Utf8`), and `None` becomes null.

```python
>>> data = {
...     "id": [1, 2, 3, 4],
...     "dept": ["Eng", "Sales", "Eng", "Sales"],
...     "salary": [120000.0, 95000.0, 140000.0, 80000.0],
... }
>>> df = iara.from_dict(data)
>>> df.show()
shape: (4, 3)
+----+-------+----------+
| id | dept  | salary   |
+----+-------+----------+
| 1  | Eng   | 120000.0 |
| 2  | Sales | 95000.0  |
| 3  | Eng   | 140000.0 |
| 4  | Sales | 80000.0  |
+----+-------+----------+
```

---

## 2. Lazy Execution with LazyFrame

Iara uses a lazy-first evaluation model. Query chains built with `LazyFrame` do not compute immediately; they construct an optimized logical plan that executes only when `.collect()` or a streaming sink is invoked.

```python
>>> lf = df.lazy()
>>> filtered = (
...     lf.filter(F.col("salary") >= 100000.0)
...     .select(
...         F.col("id"),
...         F.col("dept"),
...         (F.col("salary") * 1.10).alias("bonus_salary")
...     )
...     .sort("bonus_salary", descending=True)
... )
>>> result = filtered.collect()
>>> result.show()
shape: (2, 3)
+----+------+--------------+
| id | dept | bonus_salary |
+----+------+--------------+
| 3  | Eng  | 154000.0     |
| 1  | Eng  | 132000.0     |
+----+------+--------------+
```

`explain()` prints the plan the engine will run. The filter is pushed into the in-memory scan, and the sort runs in parallel:

```python
>>> print(filtered.explain())
== Optimized logical plan ==
Sort: bonus_salary DESC NULLS FIRST
  Projection: id, dept, salary * 1.1 AS bonus_salary
    Filter: salary >= 100000.0
      Scan: memory [memory] projection=[id, dept, salary] pruning_filters=[salary >= 100000.0]

== Physical plan ==
ParallelSort: [bonus_salary@2 DESC]
  Project: id@0, dept@1, (salary@2 * 1.1)
    Filter: (salary@2 >= 100000.0)
      MemoryScan[1 morsels]
```

---

## 3. Grouping and Aggregations

Group by one or more columns and compute summary statistics using `group_by()`. Each worker thread pre-aggregates its own rows, and the partial results are merged at the end. The aggregation state is reserved from the engine's memory pool, so it spills to disk when the limit is reached (see `iara.set_memory_limit`).

```python
>>> summary = (
...     df.lazy()
...     .group_by("dept")
...     .agg(
...         headcount=F.len(),
...         avg_salary=F.col("salary").mean(),
...         max_salary=F.col("salary").max(),
...     )
...     .sort("avg_salary", descending=True)
...     .collect()
... )
>>> summary.show()
shape: (2, 4)
+-------+-----------+------------+------------+
| dept  | headcount | avg_salary | max_salary |
+-------+-----------+------------+------------+
| Eng   | 2         | 130000.0   | 140000.0   |
| Sales | 2         | 87500.0    | 95000.0    |
+-------+-----------+------------+------------+
```

---

## 4. Querying with SQL

Execute standard ANSI SQL queries against frames or registered tables using `iara.sql()`. Each keyword argument names a table for that query, and the result is a `LazyFrame` that runs when it is collected:

```python
>>> sql_result = iara.sql("""
...     SELECT dept, count(*) as count, sum(salary) as total_payroll
...     FROM employees
...     WHERE salary > 90000
...     GROUP BY dept
... """, employees=df).collect()
>>> sql_result.show()
shape: (2, 3)
+-------+-------+---------------+
| dept  | count | total_payroll |
+-------+-------+---------------+
| Eng   | 2     | 260000.0      |
| Sales | 1     | 95000.0       |
+-------+-------+---------------+
```

---

## 5. Reading and Writing Parquet Files

Scan and write Parquet files locally or over `s3://` URLs:

```python
# Lazily scan files matching a glob pattern
lf = iara.scan_parquet("data/transactions/*.parquet")

# Process and stream directly to output files without holding full data in memory
row_count = lf.filter(F.col("status") == "COMPLETED").sink_parquet("data/completed_transactions.parquet")
print(f"Wrote {row_count} rows.")
```

`sink_parquet` writes rows while the query runs and returns the number of rows written. The file appears only when the write completes, so a failed query leaves no partial file behind. With `partition_by`, the path is a folder of Hive-style `key=value` partitions.

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

`to_arrow()` returns a `pyarrow.Table` over the engine's record batches. `to_pandas()` maps dates to `datetime64` columns and decimals to exact Arrow decimal types. `to_polars()` builds a Polars DataFrame from the same Arrow data.
