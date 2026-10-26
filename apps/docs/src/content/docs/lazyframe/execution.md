---
title: LazyFrame Execution & Plans
description: Materializing results, explaining plans, and profiling queries.
---

## How it works

An action optimizes the logical plan, builds the physical plan (the operators and the pipelines that run them) and runs it. The optimizer folds constants, pushes filters and limits toward the sources, removes the columns that no step reads, and rewrites some aggregates. `explain()` shows the result of that step without running the query.

A physical plan is a set of pipelines. The input of a pipeline is split into morsels: row groups of a Parquet file, chunks of an in-memory table, byte ranges of a CSV file. Worker threads take morsels one at a time, push their batches through the operators, and keep per-thread state. Operators that need every row before they can emit (sort, aggregation, the build side of a join) combine the per-thread states once all morsels are done. `collect()` releases the Python GIL while it runs, so other Python threads keep running.

Operators that hold data across morsels reserve their memory from one pool. The limit is set with `IARA_MEMORY_LIMIT`: a byte count (`2147483648`), a size with a unit (`2GB`, `512MB`), or a share of the machine's RAM (`60%`). Without it a query may use up to 75% of RAM, less when less is free at the start. When a reservation would go over the limit, sorts, aggregations and join builds spill to disk instead of growing.

## Methods

### `LazyFrame.collect`

Executes the query plan across all available CPU cores and returns a materialized in-memory `DataFrame`. Releases the Python GIL during execution. The whole result is held in memory: for results larger than memory, use the sinks or the streaming methods.

```python
LazyFrame.collect() -> DataFrame
```

#### Returns
- **`DataFrame`**: A materialized tabular result backed by Arrow record batches.

#### Example
```python
>>> import iara
>>> from iara import functions as F
>>> df = iara.from_dict({"n": [1, 2, 3]}).lazy().filter(F.col("n") > 1).collect()
>>> df.show()
shape: (2, 1)
+---+
| n |
+---+
| 2 |
| 3 |
+---+
```

`show(n=10)` prints the first `n` rows, followed by `... N more rows` when there are more. `to_dicts()` and `to_pydict()` return the rows as Python objects.

---

### `LazyFrame.fetch`

Appends an internal limit of `n` rows and immediately executes `.collect()`. Useful for inspecting small samples quickly. The limit is pushed into the scans like `limit()`.

```python
LazyFrame.fetch(n: int = 5) -> DataFrame
```

#### Example
```python
>>> lf = iara.scan_parquet("data/large.parquet")
>>> sample = lf.fetch(2)
>>> len(sample)
2
```

---

### `LazyFrame.preview`

Shows the first `n` rows of the query, running it with a limit. In a Studio notebook the rows become the cell's table output, which can be paged, sorted and downloaded. Elsewhere they are printed. A frame that ends a cell is not shown on its own, because `collect()` only collects: call `preview()` or `show()` to see the rows.

```python
LazyFrame.preview(n: int = 500) -> None
```

#### Parameters
- **`n`** (`int`, default `500`): Number of rows to show.

#### Example
```python
>>> iara.from_dict({"n": [1, 2]}).lazy().preview(1)
shape: (1, 1)
+---+
| n |
+---+
| 1 |
+---+
```

---

### `LazyFrame.explain`

Returns the formatted plan as a string, without running the query. With `optimized=True` (the default) it has two sections: the optimized logical plan, then the physical execution plan. With `optimized=False` it returns the logical plan as built, before the optimizer ran.

```python
LazyFrame.explain(optimized: bool = True) -> str
```

#### Example
```python
>>> lf = iara.from_dict({"a": [1, 2]}).lazy().filter(F.col("a") == 1)
>>> print(lf.explain())
== Optimized logical plan ==
Filter: a = 1
  Scan: memory [memory] projection=[a] pruning_filters=[a = 1]

== Physical plan ==
Filter: (a@0 = 1)
  MemoryScan[1 morsels]
```

The `pruning_filters` entry on a scan is a predicate the scan uses to skip data (row groups of a Parquet file, for example). A `LIMIT` shows as `fetch=` on the scan, and a sort followed by a limit shows as `TopK`.

---

### `LazyFrame.explain_tree`

Returns the hierarchical physical execution plan as a nested dictionary (`{name, detail, role, children}`).

```python
LazyFrame.explain_tree() -> dict[str, Any]
```

#### Example
```python
>>> tree = lf.explain_tree()
>>> tree["name"]
'Filter'
```

---

### `LazyFrame.profile`

Executes the query and returns a tuple of the materialized `DataFrame` and a detailed execution profile dictionary containing runtime metrics per pipeline.

```python
LazyFrame.profile() -> tuple[DataFrame, dict[str, Any]]
```

#### Returns
- **`DataFrame`**: Materialized query result.
- **`dict`**: Run profile containing `elapsed_ms` (milliseconds), `memory_peak` (bytes), `spilled_bytes`, and a `pipelines` list. Each pipeline entry has `rows_in`, `rows_out`, `morsels_total`, `morsels_done`, `elapsed_ms` and `finished`.

#### Example
```python
>>> df, prof = lf.profile()
>>> prof["memory_peak"]
1048576
>>> prof["elapsed_ms"]
4.2
```

---

### `LazyFrame.analyze`

Executes the query with per-operator runtime measurement enabled. The result is read batch by batch and discarded, so nothing is collected. Returns operator metrics, memory peaks, elapsed times, and storage requests.

```python
LazyFrame.analyze() -> dict[str, Any]
```

#### Example
```python
>>> analysis = lf.analyze()
>>> analysis.keys()
dict_keys(['plan', 'profile', 'rows', 'requests'])
```
