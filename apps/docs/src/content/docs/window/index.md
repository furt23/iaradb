---
title: Window Functions & over()
description: Partitioned and ordered analytical window calculations.
---

Window functions compute values across rows related to the current row without collapsing the rows into a single group.

In Iara, windowing is applied to expressions using the `.over()` method.

```python
import iara
from iara import functions as F
```

---

### `Expr.over`

Evaluates aggregations or window functions over groups defined by `partition_by` and ordered by `order_by`.

```python
Expr.over(
    partition_by: Any = None,
    *more_by: Any,
    order_by: Any = None,
    descending: bool | Sequence[bool] = False,
    nulls_last: bool | Sequence[bool] = False,
    frame: tuple[str, int | None, int | None] | None = None
) -> Expr
```

#### Parameters
- **`partition_by`**: Column(s) defining partition groups. If omitted, the window spans the entire dataset.
- **`order_by`**: Column(s) specifying row order within each partition.
- **`descending`** (`bool | list[bool]`): Sort direction for `order_by`.
- **`nulls_last`** (`bool | list[bool]`): Null position for `order_by`.
- **`frame`**: Custom window frame `(units, start, end)` where units is `"rows"`, `"range"`, or `"groups"`.

---

### Example: Group Mean & Demeaning
```python
>>> df = iara.from_dict({
...     "group": ["A", "A", "B", "B"],
...     "val": [10.0, 20.0, 100.0, 200.0]
... })
>>> df.lazy().with_columns(
...     group_avg=F.col("val").mean().over("group"),
...     demeaned=(F.col("val") - F.col("val").mean()).over("group")
... ).collect().show()
┌───────┬───────┬───────────┬──────────┐
│ group │ val   │ group_avg │ demeaned │
│ utf8  │ f64   │ f64       │ f64      │
├───────┼───────┼───────────┼──────────┤
│ A     │ 10.0  │ 15.0      │ -5.0     │
│ A     │ 20.0  │ 15.0      │ 5.0      │
│ B     │ 100.0 │ 150.0     │ -50.0    │
│ B     │ 200.0 │ 150.0     │ 50.0     │
└───────┴───────┴───────────┴──────────┘
```

---

## Window Function Categories

- [**Ranking Functions**](/window/ranking/): `rank()`, `dense_rank`, `row_number()`
- [**Offsets & Differences**](/window/offsets/): `shift()`, `diff()`
- [**Cumulative Aggregations**](/window/cumulative/): `cum_sum()`, `cum_min()`, `cum_max()`, `cum_count()`
- [**Rolling Windows**](/window/rolling/): `rolling_sum()`, `rolling_mean()`, `rolling_std()`, `rolling_min()`, `rolling_max()`
