---
title: LazyFrame Sorting & Reordering
description: Sorting rows by one or more keys.
---

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

#### Example: Single Column Sort
```python
>>> import iara
>>> df = iara.from_dict({"city": ["Paris", "Tokyo", "Berlin"], "pop_m": [2.1, 14.0, 3.6]})
>>> df.lazy().sort("pop_m", descending=True).collect().show()
┌────────┬───────┐
│ city   │ pop_m │
│ utf8   │ f64   │
├────────┼───────┤
│ Tokyo  │ 14.0  │
│ Berlin │ 3.6   │
│ Paris  │ 2.1   │
└────────┴───────┘
```

#### Example: Multi-Key Sort with Mixed Directions
```python
>>> df = iara.from_dict({
...     "dept": ["IT", "Sales", "IT", "Sales"],
...     "salary": [90000, 80000, 110000, 95000],
... })
>>> df.lazy().sort(["dept", "salary"], descending=[False, True]).collect().show()
┌───────┬────────┐
│ dept  │ salary │
│ utf8  │ i64    │
├───────┼────────┤
│ IT    │ 110000 │
│ IT    │ 90000  │
│ Sales │ 95000  │
│ Sales │ 80000  │
└───────┴────────┘
```
