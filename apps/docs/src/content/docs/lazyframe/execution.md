---
title: LazyFrame Execution & Plans
description: Materializing results, explaining plans, and profiling queries.
---

### `LazyFrame.collect`

Executes the query plan across all available CPU cores and returns a materialized in-memory `DataFrame`. Releases the Python GIL during execution.

```python
LazyFrame.collect() -> DataFrame
```

#### Returns
- **`DataFrame`**: A materialized tabular result backed by Arrow record batches.

#### Example
```python
>>> import workhouse as wh
>>> df = wh.from_dict({"n": [1, 2, 3]}).lazy().filter(wh.col("n") > 1).collect()
>>> df.show()
┌─────┐
│ n   │
│ i64 │
├─────┤
│ 2   │
│ 3   │
└─────┘
```

---

### `LazyFrame.fetch`

Appends an internal limit of `n` rows and immediately executes `.collect()`. Useful for inspecting small samples quickly.

```python
LazyFrame.fetch(n: int = 5) -> DataFrame
```

#### Example
```python
>>> lf = wh.scan_parquet("data/large.parquet")
>>> sample = lf.fetch(2)
>>> len(sample)
2
```

---

### `LazyFrame.explain`

Returns the formatted plan as a string. Displays the optimized logical plan followed by the physical execution pipeline.

```python
LazyFrame.explain(optimized: bool = True) -> str
```

#### Example
```python
>>> lf = wh.from_dict({"a": [1, 2]}).lazy().filter(wh.col("a") == 1)
>>> print(lf.explain())
PhysicalPlan
  FilterExec: a == 1
    MemoryScanExec: 2 rows
```

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
'FilterExec'
```

---

### `LazyFrame.profile`

Executes the query and returns a tuple of the materialized `DataFrame` and a detailed execution profile dictionary containing runtime metrics per pipeline.

```python
LazyFrame.profile() -> tuple[DataFrame, dict[str, Any]]
```

#### Returns
- **`DataFrame`**: Materialized query result.
- **`dict`**: Run profile containing `elapsed_ms`, `memory_peak`, `spilled_bytes`, and detailed `pipelines` list.

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

Executes the query with per-operator runtime measurement enabled (streaming and counting rows without collecting them in memory). Returns operator metrics, memory peaks, elapsed times, and storage requests.

```python
LazyFrame.analyze() -> dict[str, Any]
```

#### Example
```python
>>> analysis = lf.analyze()
>>> analysis.keys()
dict_keys(['plan', 'profile', 'rows', 'requests'])
```
