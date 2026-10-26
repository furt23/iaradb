---
title: LazyFrame Overview
description: The core lazy query abstraction in Iara.
---

A `LazyFrame` represents an uncomputed query plan. Chaining methods on a `LazyFrame` appends transformations to an internal logical plan without executing computation or consuming memory for intermediate results.

Execution begins only when an action is invoked, such as [`.collect()`](/lazyframe/execution/), [`.fetch()`](/lazyframe/execution/), or [`.sink_parquet()`](/lazyframe/streaming/).

```python
import iara
from iara import functions as F
```

## How it works

A `LazyFrame` holds a logical plan: a tree of steps over its sources. A source is a file scan (`scan_parquet()`, `scan_csv()`, `scan_delta()`, `scan_ndjson()`) or an in-memory frame (`from_dict()`, `from_arrow()`, or `DataFrame.lazy()`). Each method returns a new `LazyFrame` with one more step on top of the plan. Building the plan reads no rows, but it is checked as it grows: an unknown column name, or a filter that is not a boolean expression, raises when the method is called, not when the query runs. A Parquet scan reads the file's metadata when it is created, so a missing file raises there. The column names and types are known from the plan, which is why `.columns` and `.schema` need no execution.

Each action optimizes the plan, builds the physical plan and runs it. The actions are `collect()`, `fetch()`, `preview()`, `profile()` and `analyze()`; the sinks `sink_parquet()`, `sink_csv()`, `sink_ndjson()` and `sink_delta()`; and the streaming methods `stream()`, `to_reader()` and `iter_batches()`. No result is kept between actions, so calling `collect()` twice runs the query twice. [Execution](/lazyframe/execution/) describes what an action does.

Types use Arrow-style names such as `Int64`, `Float64`, `Utf8` and `Boolean`. Row order is defined only by the steps that define it, such as `sort()`; each page says which steps keep the input order.

## Properties

### `LazyFrame.columns`
Returns the list of column names projected by the current query plan.

```python
>>> lf = iara.scan_parquet("data/users.parquet")
>>> lf.columns
['id', 'name', 'department', 'salary']
```

---

### `LazyFrame.schema`
Returns a mapping of column names to their data types.

```python
>>> lf.schema
{'id': 'Int64', 'name': 'Utf8', 'department': 'Utf8', 'salary': 'Float64'}
```

---

## Method Categories

- [**Selection & Projections**](/lazyframe/selection/): `select()`, `with_columns()`, `drop()`, `rename()`
- [**Filtering & Slicing**](/lazyframe/filtering/): `filter()`, `where()`, `limit()`, `head()`, `slice()`, `unique()`, `distinct()`
- [**Grouping & Aggregations**](/lazyframe/grouping/): `group_by()`, `agg()`
- [**Joins & Set Operations**](/lazyframe/joins/): `join()`, `union()`
- [**Sorting & Ordering**](/lazyframe/sorting/): `sort()`
- [**Execution & Plans**](/lazyframe/execution/): `collect()`, `fetch()`, `preview()`, `explain()`, `explain_tree()`, `profile()`, `analyze()`
- [**Streaming & Sinks**](/lazyframe/streaming/): `sink_parquet()`, `sink_csv()`, `sink_ndjson()`, `sink_delta()`, `stream()`, `to_reader()`, `iter_batches()`
