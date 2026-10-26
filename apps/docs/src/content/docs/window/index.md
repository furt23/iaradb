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

## How it works

A window has three parts. The partition (`partition_by`) splits the rows into independent groups. The order (`order_by`) sorts the rows inside each partition. The frame selects, for each row, which rows of its partition an aggregate reads, for example all rows from the start of the partition up to the current one. Without `partition_by` the whole dataset is one partition; without `order_by` the rows are used in input order.

A window expression returns one value per input row, so the row count does not change. `F.col("val").mean().over("group")` repeats each group's mean on every row of that group, where `group_by` would return one row per group. Rows with equal order values are peers: `rank()` gives them the same rank (`"ordinal"` does not), and RANGE frames include all of them. Nulls sort first in `order_by` unless `nulls_last=True`. Rows with a null partition key form one partition.

For each distinct `partition_by` and `order_by` in a query, the engine sorts the input once (the sort is stable, so tied rows keep their input order), finds the partition and peer boundaries, evaluates the functions one partition at a time in parallel, and writes the results back to the input rows. Functions with the same partition and order share that sort. A window made only of whole-partition aggregates is computed by hashing its partition keys, with no sort. The input is held in memory. If it does not fit under the memory limit and all windows share their partition keys, it is spilled to disk by those keys, and the result comes out grouped by partition instead of in input order.

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

`over` turns an aggregate into a window aggregate and gives partition and order to window functions that were created without them. An aggregate passed through `over` covers its whole partition, even when `order_by` is set, unless `frame` is given. A `rank` keeps the order of the expression it ranks, so an `order_by` given to `over` does not change it.

#### Parameters
- **`partition_by`**: Column(s) defining partition groups. If omitted, the window spans the entire dataset.
- **`order_by`**: Column(s) specifying row order within each partition.
- **`descending`** (`bool | list[bool]`): Sort direction for `order_by`.
- **`nulls_last`** (`bool | list[bool]`): Null position for `order_by`.
- **`frame`**: Custom window frame `(units, start, end)` where units is `"rows"`, `"range"`, or `"groups"`.

#### Frames

The offsets of a frame are whole numbers relative to the current row: `0` is the current row, a negative number is preceding, a positive number is following, and `None` is unbounded. The frame is cut at the edges of the partition. What the offsets count depends on `units`:

- `"rows"`: rows. `("rows", -2, 0)` is the current row and the two rows before it.
- `"range"`: values of the single `order_by` key. On an integer key, `("range", -2, 0)` is every row whose key lies between the current key minus 2 and the current key. Peers of the current row are included. A row with a null key sees only the rows with null keys. Requires exactly one order key.
- `"groups"`: peer groups. `("groups", None, 0)` runs from the start of the partition to the end of the current peer group. Requires `order_by`.

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

### Example: Running Sums and Frames

Two rows share `t = 1`, so they are peers. The plain aggregate covers the whole partition. A `"rows"` frame runs row by row, and a `"range"` frame includes the peers of the current row.

```python
>>> df = iara.from_dict({"g": ["a", "a", "a", "a"], "t": [1, 1, 2, 3], "v": [1, 2, 3, 4]})
>>> df.lazy().with_columns(
...     total=F.col("v").sum().over("g", order_by="t"),
...     running=F.col("v").sum().over("g", order_by="t", frame=("rows", None, 0)),
...     running_peers=F.col("v").sum().over("g", order_by="t", frame=("range", None, 0)),
... ).collect().show()
┌──────┬─────┬─────┬───────┬─────────┬───────────────┐
│ g    │ t   │ v   │ total │ running │ running_peers │
│ utf8 │ i64 │ i64 │ i64   │ i64     │ i64           │
├──────┼─────┼─────┼───────┼─────────┼───────────────┤
│ a    │ 1   │ 1   │ 10    │ 1       │ 3             │
│ a    │ 1   │ 2   │ 10    │ 3       │ 3             │
│ a    │ 2   │ 3   │ 10    │ 6       │ 6             │
│ a    │ 3   │ 4   │ 10    │ 10      │ 10            │
└──────┴─────┴─────┴───────┴─────────┴───────────────┘
```

---

## Window Function Categories

- [**Ranking Functions**](/window/ranking/): `rank()` (including `rank("dense")`), `row_number()`
- [**Offsets & Differences**](/window/offsets/): `shift()`, `diff()`
- [**Cumulative Aggregations**](/window/cumulative/): `cum_sum()`, `cum_min()`, `cum_max()`, `cum_count()`
- [**Rolling Windows**](/window/rolling/): `rolling_sum()`, `rolling_mean()`, `rolling_std()`, `rolling_min()`, `rolling_max()`
