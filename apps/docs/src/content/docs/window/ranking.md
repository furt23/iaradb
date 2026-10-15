---
title: Window Ranking Functions
description: Ranking methods and row numbering across partition groups.
---

### `Expr.rank`

Computes the numerical rank of values. Null values receive null ranks.

```python
Expr.rank(method: str = "average", *, descending: bool = False) -> Expr
```

#### Ranking Methods
- **`"average"`** (default): Average rank assigned to tied peers.
- **`"min"`**: Lowest rank assigned to tied peers (standard SQL `RANK()`).
- **`"max"`**: Highest rank assigned to tied peers.
- **`"dense"`**: Consecutive integer ranks with no gaps between ties (SQL `DENSE_RANK()`).
- **`"ordinal"`**: Unique integer assigned sequentially to each row (SQL `ROW_NUMBER()`).

---

### `F.row_number`

Returns the 1-based sequential row position within each partition group.

```python
F.row_number() -> Expr
```

---

### Example: Top-N per Group
```python
>>> import workhouse
>>> from workhouse import functions as F
>>> df = workhouse.from_dict({
...     "dept": ["IT", "IT", "IT", "Sales", "Sales"],
...     "name": ["Alice", "Bob", "Charlie", "David", "Emma"],
...     "score": [95, 95, 80, 88, 92],
... })
>>> ranked = df.lazy().with_columns(
...     dense_rk=F.col("score").rank("dense", descending=True).over("dept"),
...     row_num=F.row_number().over("dept", order_by=F.col("score"), descending=True)
... ).filter(F.col("dense_rk") <= 1).collect()
>>> ranked.show()
┌──────┬───────┬───────┬──────────┬─────────┐
│ dept │ name  │ score │ dense_rk │ row_num │
│ utf8 │ utf8  │ i64   │ u64      │ u64     │
├──────┼───────┼───────┼──────────┼─────────┤
│ IT   │ Alice │ 95    │ 1        │ 1       │
│ IT   │ Bob   │ 95    │ 1        │ 2       │
│ Sales│ Emma  │ 92    │ 1        │ 1       │
└──────┴───────┴───────┴──────────┴─────────┘
```
