---
title: Cumulative Window Aggregations
description: Running totals, minimums, maximums, and counts over frames.
---

Cumulative methods compute running statistics from the beginning of the partition up to the current row.

## How it works

The cumulative functions read a frame that runs from the start of the partition to the current row, in the window's order. The frame counts rows, not values, so tied rows are not peers: each row sees the rows up to itself, and a later row with the same order value is not yet included. To include all rows tied with the current one, use an aggregate with a `"range"` frame instead, as shown in the last example. `reverse=True` runs from the current row to the end of the partition.

Nulls: `cum_sum`, `cum_min` and `cum_max` skip null values in the running state, and their result is null on a row whose own value is null. `cum_count` counts non-null values, so it is never null; it is 0 until the first non-null value.

Running sums of integers and decimals are computed as prefix sums in one pass over each partition. The other functions move a state along the partition. An integer sum that overflows raises an error.

---

### Methods

- **`Expr.cum_sum(*, reverse=False)`**: Running cumulative sum.
- **`Expr.cum_min(*, reverse=False)`**: Running minimum value seen so far.
- **`Expr.cum_max(*, reverse=False)`**: Running maximum value seen so far.
- **`Expr.cum_count(*, reverse=False)`**: Running count of non-null values.

#### Parameters
- **`reverse`** (`bool`, default `False`): If `True`, accumulates backward from the end of the partition to the current row.

---

### Example: Running Ledger Balance
```python
>>> import iara
>>> from iara import functions as F
>>> df = iara.from_dict({
...     "account": ["A1", "A1", "A1"],
...     "tx": [100.0, -40.0, 25.0]
... })
>>> df.lazy().with_columns(
...     balance=F.col("tx").cum_sum().over("account"),
...     tx_count=F.col("tx").cum_count().over("account")
... ).collect().show()
┌─────────┬───────┬─────────┬──────────┐
│ account │ tx    │ balance │ tx_count │
│ utf8    │ f64   │ f64     │ i64      │
├─────────┼───────┼─────────┼──────────┤
│ A1      │ 100.0 │ 100.0   │ 1        │
│ A1      │ -40.0 │ 60.0    │ 2        │
│ A1      │ 25.0  │ 85.0    │ 3        │
└─────────┴───────┴─────────┴──────────┘
```

### Example: Running Totals with Tied Order Values

The first two rows share `t = 1`. `cum_sum` gives each row its own running total. The `"range"` sum gives both tied rows the total of the peer group.

```python
>>> df = iara.from_dict({"g": ["a", "a", "a", "a"], "t": [1, 1, 2, 3], "v": [1, 2, 3, 4]})
>>> df.lazy().with_columns(
...     cum=F.col("v").cum_sum().over("g", order_by="t"),
...     cum_rev=F.col("v").cum_sum(reverse=True).over("g", order_by="t"),
... ).collect().show()
┌──────┬─────┬─────┬─────┬─────────┐
│ g    │ t   │ v   │ cum │ cum_rev │
│ utf8 │ i64 │ i64 │ i64 │ i64     │
├──────┼─────┼─────┼─────┼─────────┤
│ a    │ 1   │ 1   │ 1   │ 10      │
│ a    │ 1   │ 2   │ 3   │ 9       │
│ a    │ 2   │ 3   │ 6   │ 7       │
│ a    │ 3   │ 4   │ 10  │ 4       │
└──────┴─────┴─────┴─────┴─────────┘
```

To get the peer-inclusive total instead, use `F.col("v").sum().over("g", order_by="t", frame=("range", None, 0))`. For the data above it gives 3, 3, 6, 10.
