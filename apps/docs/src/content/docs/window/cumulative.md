---
title: Cumulative Window Aggregations
description: Running totals, minimums, maximums, and counts over frames.
---

Cumulative methods compute running statistics from the beginning of the partition up to the current row.

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
>>> import workhouse as wh
>>> from workhouse import col
>>> df = wh.from_dict({
...     "account": ["A1", "A1", "A1"],
...     "tx": [100.0, -40.0, 25.0]
... })
>>> df.lazy().with_columns(
...     balance=col("tx").cum_sum().over("account"),
...     tx_count=col("tx").cum_count().over("account")
... ).collect().show()
┌─────────┬───────┬─────────┬──────────┐
│ account │ tx    │ balance │ tx_count │
│ utf8    │ f64   │ f64     │ u64      │
├─────────┼───────┼─────────┼──────────┤
│ A1      │ 100.0 │ 100.0   │ 1        │
│ A1      │ -40.0 │ 60.0    │ 2        │
│ A1      │ 25.0  │ 85.0    │ 3        │
└─────────┴───────┴─────────┴──────────┘
```
