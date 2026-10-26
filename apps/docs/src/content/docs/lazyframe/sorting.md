---
title: LazyFrame Sorting & Reordering
description: Sorting rows by one or more keys.
---

## How it works

`sort()` orders the whole result by its keys, in the order the keys are given. The sort is stable: rows with equal keys keep their input order. It runs in parallel. Under the memory limit, a sort that does not fit writes sorted runs to disk and merges them at the end.

Nulls come first by default, for ascending and for descending keys alike. `nulls_last=True` moves them to the end for every key, in either direction. When `limit()` or `head()` follows a sort, the engine keeps only the top rows (a top-k step, shown as `TopK` in the explain output) instead of sorting all the rows.

## Methods

### `LazyFrame.sort`

Sorts rows by one or more column expressions.

```python
LazyFrame.sort(
    by: Any,
    *more_by: Any,
    descending: bool | Sequence[bool] = False,
    nulls_last: bool | Sequence[bool] = False
) -> LazyFrame
```

#### Parameters
- **`by`** (`str | Expr`): Primary sort column name or expression.
- **`*more_by`**: Additional tie-breaking sort keys.
- **`descending`** (`bool | list[bool]`, default `False`): Sort direction. A list specifies directions per sort key.
- **`nulls_last`** (`bool | list[bool]`, default `False`): Whether null values sort last.

#### Notes
- A list for `descending` or `nulls_last` that is shorter than the keys leaves the other keys ascending, or with nulls first.

#### Example: Single Column Sort
```python
>>> import iara
>>> df = iara.from_dict({"city": ["Paris", "Tokyo", "Berlin"], "pop_m": [2.1, 14.0, 3.6]})
>>> df.lazy().sort("pop_m", descending=True).collect().show()
shape: (3, 2)
+--------+-------+
| city   | pop_m |
+--------+-------+
| Tokyo  | 14.0  |
| Berlin | 3.6   |
| Paris  | 2.1   |
+--------+-------+
```

#### Example: Multi-Key Sort with Mixed Directions
```python
>>> df = iara.from_dict({
...     "dept": ["IT", "Sales", "IT", "Sales"],
...     "salary": [90000, 80000, 110000, 95000],
... })
>>> df.lazy().sort(["dept", "salary"], descending=[False, True]).collect().show()
shape: (4, 2)
+-------+--------+
| dept  | salary |
+-------+--------+
| IT    | 110000 |
| IT    | 90000  |
| Sales | 95000  |
| Sales | 80000  |
+-------+--------+
```

#### Example: Null Placement
```python
>>> df = iara.from_dict({"x": [2, None, 1]})
>>> df.lazy().sort("x").collect().to_dicts()
[{'x': None}, {'x': 1}, {'x': 2}]
>>> df.lazy().sort("x", descending=True).collect().to_dicts()
[{'x': None}, {'x': 2}, {'x': 1}]
>>> df.lazy().sort("x", nulls_last=True).collect().to_dicts()
[{'x': 1}, {'x': 2}, {'x': None}]
```
