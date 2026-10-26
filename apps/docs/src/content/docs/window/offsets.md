---
title: Window Offsets & Differences
description: Shifting values and computing differences across sequential rows.
---

## How it works

`shift(n)` reads the value `n` rows before the current row, in the window's order and inside the partition. The first `n` rows of each partition have no such row. Those rows get `fill_value`, or null. A null in the data is not filled: a null value is passed on as null.

`diff(n)` is `self - self.shift(n)`, so it is null on the edge rows and wherever either of the two values is null. Set the row order with `over(order_by=...)`. Without it, the input order is used.

---

### `Expr.shift`

Returns the value from `n` rows prior to the current row (or subsequent rows when `n` is negative). Maps to `LAG` / `LEAD`.

```python
Expr.shift(n: int = 1, *, fill_value: Any = None) -> Expr
```

The result has the dtype of the column. With `fill_value`, the result has the common supertype of the column and the fill value: an `i64` column filled with `0.5` becomes `f64`. A negative `n` reads the rows after the current one, so `shift(-1)` is a lead.

#### Parameters
- **`n`** (`int`, default `1`): Number of rows to shift. Positive shifts fetch preceding rows; negative shifts fetch succeeding rows.
- **`fill_value`** (optional): Value used to replace nulls for boundary rows.

#### Notes
- `fill_value` applies only to rows with no source row, at the edges of each partition. A null in the column stays null.

---

### `Expr.diff`

Computes the difference between the current value and the value `n` rows prior: `self - self.shift(n)`.

```python
Expr.diff(n: int = 1) -> Expr
```

The result has the dtype of the subtraction. It is null on the first `n` rows of each partition, and wherever the current value or the value `n` rows before is null.

---

### Example: Timeseries Day-over-Day Changes
```python
>>> import iara
>>> from iara import functions as F
>>> df = iara.from_dict({
...     "ticker": ["AAPL", "AAPL", "AAPL"],
...     "price": [150.0, 155.0, 153.0]
... })
>>> df.lazy().with_columns(
...     prev_price=F.col("price").shift(1).over("ticker"),
...     price_change=F.col("price").diff(1).over("ticker")
... ).collect().show()
┌────────┬───────┬────────────┬──────────────┐
│ ticker │ price │ prev_price │ price_change │
│ utf8   │ f64   │ f64        │ f64          │
├────────┼───────┼────────────┼──────────────┤
│ AAPL   │ 150.0 │ null       │ null         │
│ AAPL   │ 155.0 │ 150.0      │ 5.0          │
│ AAPL   │ 153.0 │ 155.0      │ -2.0         │
└────────┴───────┴────────────┴──────────────┘
```

### Example: Fill Value and Leads
```python
>>> df = iara.from_dict({"v": [1, 2, 3, 4]})
>>> df.lazy().with_columns(
...     prev=F.col("v").shift(1, fill_value=0),
...     next=F.col("v").shift(-1),
... ).collect().show()
┌─────┬──────┬──────┐
│ v   │ prev │ next │
│ i64 │ i64  │ i64  │
├─────┼──────┼──────┤
│ 1   │ 0    │ 2    │
│ 2   │ 1    │ 3    │
│ 3   │ 2    │ 4    │
│ 4   │ 3    │ null │
└─────┴──────┴──────┘
```
