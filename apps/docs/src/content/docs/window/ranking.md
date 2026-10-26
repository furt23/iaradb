---
title: Window Ranking Functions
description: Ranking methods and row numbering across partition groups.
---

## How it works

Ranking functions do not use a frame. They rank the rows of each partition in the window's order. Rows with equal values (peers) share a rank, and the ranking methods differ in the number they give a tie.

`rank` orders the rows by the expression it ranks, so `F.col("score").rank()` ranks by `score`, and an `order_by` passed to `over()` does not change it. `F.row_number()` has no expression of its own, so its order comes from `over(order_by=...)`, or from input order when there is none.

A null value gets a null rank. Inside `rank`, nulls sort last whatever `descending` is, so they never shift the rank of another value. This differs from `over(order_by=...)`, which sorts nulls first unless `nulls_last=True`, so a `row_number` with `order_by` numbers null rows first by default.

---

### `Expr.rank`

Computes the numerical rank of values. Null values receive null ranks.

```python
Expr.rank(method: str = "average", *, descending: bool = False) -> Expr
```

The smallest value gets rank 1, or the largest with `descending=True`. The result is `f64` for `"average"` and `i64` for the other methods.

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

Rows are numbered in the order given by `over(order_by=...)`. Tied rows get consecutive numbers in input order. The result is `i64` and never null. The function takes no column; the partition and order come from `over()`.

---

### Example: Rank Methods on Ties

The two rows with value 20 are peers. Each method gives them a different number.

```python
>>> df = iara.from_dict({"v": [10, 20, 20, 30]})
>>> df.lazy().with_columns(
...     average=F.col("v").rank("average"),
...     min=F.col("v").rank("min"),
...     max=F.col("v").rank("max"),
...     dense=F.col("v").rank("dense"),
...     ordinal=F.col("v").rank("ordinal"),
... ).collect().show()
┌─────┬─────────┬─────┬─────┬───────┬─────────┐
│ v   │ average │ min │ max │ dense │ ordinal │
│ i64 │ f64     │ i64 │ i64 │ i64   │ i64     │
├─────┼─────────┼─────┼─────┼───────┼─────────┤
│ 10  │ 1.0     │ 1   │ 1   │ 1     │ 1       │
│ 20  │ 2.5     │ 2   │ 3   │ 2     │ 2       │
│ 20  │ 2.5     │ 2   │ 3   │ 2     │ 3       │
│ 30  │ 4.0     │ 4   │ 4   │ 3     │ 4       │
└─────┴─────────┴─────┴─────┴───────┴─────────┘
```

### Example: Top-N per Group
```python
>>> import iara
>>> from iara import functions as F
>>> df = iara.from_dict({
...     "dept": ["IT", "IT", "IT", "Sales", "Sales"],
...     "name": ["Alice", "Bob", "Charlie", "David", "Emma"],
...     "score": [95, 95, 80, 88, 92],
... })
>>> ranked = df.lazy().with_columns(
...     dense_rk=F.col("score").rank("dense", descending=True).over("dept"),
...     row_num=F.row_number().over("dept", order_by=F.col("score"), descending=True)
... ).filter(F.col("dense_rk") <= 1).collect()
>>> ranked.show()
┌───────┬───────┬───────┬──────────┬─────────┐
│ dept  │ name  │ score │ dense_rk │ row_num │
│ utf8  │ utf8  │ i64   │ i64      │ i64     │
├───────┼───────┼───────┼──────────┼─────────┤
│ IT    │ Alice │ 95    │ 1        │ 1       │
│ IT    │ Bob   │ 95    │ 1        │ 2       │
│ Sales │ Emma  │ 92    │ 1        │ 1       │
└───────┴───────┴───────┴──────────┴─────────┘
```
