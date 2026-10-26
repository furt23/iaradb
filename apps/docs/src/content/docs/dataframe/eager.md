---
title: DataFrame Eager Operations
description: Immediate transformations on in-memory DataFrames.
---

## How it works

`DataFrame.lazy()` wraps the frame's batches as the source of a query, without copying them. The methods on a `LazyFrame` only build a plan; nothing runs until `collect()`. The eager methods on a `DataFrame` are shortcuts for `.lazy().<method>().collect()`: each call plans and runs one query and returns its result as a new materialized `DataFrame`. A chain of eager calls therefore materializes every intermediate result. To run a multi-step pipeline as one query, chain the steps on `lazy()` and call `collect()` once.

Nulls follow these rules. A `filter()` keeps only the rows where the predicate is true, so a null result drops the row. In a join, a null key never matches another null. `unique()` and `group_by()` treat nulls as equal, so all null rows form one row or one group. `sort()` places nulls first by default, in both directions; `nulls_last=True` moves them last.

A `DataFrame` returned by `sort()` keeps the input batches and a sort index. The rows are reordered in memory the first time all the batches are read, for example by a conversion or a write. `show()`, `head()` and `slice()` gather only the rows they print or return.

---

### `DataFrame.lazy`

Converts the materialized `DataFrame` back into a `LazyFrame` for further query planning. The `LazyFrame` reads the same in-memory batches, so nothing is copied.

```python
DataFrame.lazy() -> LazyFrame
```

#### Example
```python
>>> import iara
>>> from iara import functions as F
>>> df = iara.from_dict({"a": [1, 2, 3]})
>>> lf = df.lazy().filter(F.col("a") > 1)
>>> type(lf)
<class 'iara.LazyFrame'>
```

---

### Eager Method Shortcuts

Every transformation available on `LazyFrame` is also provided directly on `DataFrame` as an eager shortcut (internally calling `.lazy().<method>().collect()`):

- **`DataFrame.filter(*predicates)`**: Eagerly filters rows. Several predicates are combined with AND, and a row is kept only when all of them are true.
- **`DataFrame.select(*exprs, **named)`**: Eagerly projects columns. The result has only the listed expressions, in the order given; keyword arguments name their expression, and columns not listed are dropped.
- **`DataFrame.with_columns(*exprs, **named)`**: Eagerly adds or updates columns. A column whose name already exists is replaced in place, keeping its position; other columns are unchanged.
- **`DataFrame.sort(by, ...)`**: Eagerly sorts rows. `descending` and `nulls_last` take one bool for all keys or a list with one bool per key. Nulls come first unless `nulls_last=True`.
- **`DataFrame.join(other, ...)`**: Eagerly joins with another frame. `other` can be a `DataFrame` or a `LazyFrame`. `how` is `inner` (the default), `left`, `right`, `full`, `semi`, `anti` or `cross`; `cross` takes no keys. A non-key column whose name exists on both sides gets `suffix` (default `"_right"`) on the right side.
- **`DataFrame.group_by(*keys).agg(*aggs, **named)`**: Eagerly groups and aggregates. The result has one row per distinct key combination, with the keys first and the aggregates after. A null key forms a group of its own.
- **`DataFrame.unique()`**: Eagerly deduplicates rows. All columns are compared, and two nulls in the same column count as equal.
- **`DataFrame.sql(query, table_name="self")`**: Eagerly runs SQL against the frame. The frame is the only table in scope, registered under `table_name`.

#### Example
```python
>>> df = iara.from_dict({"val": [10, 20, 30]})
>>> df.filter(F.col("val") > 15).show()
shape: (2, 1)
+-----+
| val |
+-----+
| 20  |
| 30  |
+-----+
```

#### Notes
- Each shortcut returns a new `DataFrame`; the original frame is unchanged.
- `join()`, `group_by()` and `unique()` do not promise any row order. Call `sort()` on the result when order matters.
- `join(..., how="right")` and `how="full"` keep the right-hand key column as well, with the suffix (`k_right`). With `inner`, `left` or `semi`, a shared `on` key appears once.
- `sql()` sees only the frame itself, under `table_name`. Any other table name fails with a "table ... not found" error.

#### Example: sort and nulls
```python
>>> d = iara.from_dict({"k": [2, 1, None]})
>>> d.sort("k").to_pydict()
{'k': [None, 1, 2]}
>>> d.sort("k", nulls_last=True).to_pydict()
{'k': [1, 2, None]}
```

#### Example: SQL with parameters
```python
>>> k = iara.from_dict({"k": [2, 1, None, 1]})
>>> k.sql("select count(*) as n from self where k > $1", params=[1]).to_pydict()
{'n': [1]}
```
