---
title: LazyFrame Overview
description: The core lazy query abstraction in Workhouse.
---

A `LazyFrame` represents an uncomputed query plan. Chaining methods on a `LazyFrame` appends transformations to an internal logical plan without executing computation or consuming memory for intermediate results.

Execution begins only when an action is invoked, such as [`.collect()`](/lazyframe/execution/), [`.fetch()`](/lazyframe/execution/), or [`.sink_parquet()`](/lazyframe/streaming/).

```python
import workhouse as wh
from workhouse import col
```

## Properties

### `LazyFrame.columns`
Returns the list of column names projected by the current query plan.

```python
>>> lf = wh.scan_parquet("data/users.parquet")
>>> lf.columns
['id', 'name', 'department', 'salary']
```

---

### `LazyFrame.schema`
Returns a mapping of column names to their data types.

```python
>>> lf.schema
{'id': 'int64', 'name': 'utf8', 'department': 'utf8', 'salary': 'float64'}
```

---

## Method Categories

- [**Selection & Projections**](/lazyframe/selection/): `select()`, `with_columns()`, `drop()`, `rename()`
- [**Filtering & Slicing**](/lazyframe/filtering/): `filter()`, `where()`, `limit()`, `head()`, `slice()`, `unique()`, `distinct()`
- [**Grouping & Aggregations**](/lazyframe/grouping/): `group_by()`, `agg()`
- [**Joins & Set Operations**](/lazyframe/joins/): `join()`, `union()`
- [**Sorting & Ordering**](/lazyframe/sorting/): `sort()`
- [**Execution & Plans**](/lazyframe/execution/): `collect()`, `fetch()`, `explain()`, `explain_tree()`, `profile()`, `analyze()`
- [**Streaming & Sinks**](/lazyframe/streaming/): `sink_parquet()`, `sink_csv()`, `stream()`, `to_reader()`, `iter_batches()`
