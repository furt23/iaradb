---
title: Window Offsets & Differences
description: Shifting values and computing differences across sequential rows.
---

### `Expr.shift`

Returns the value from `n` rows prior to the current row (or subsequent rows when `n` is negative). Maps to `LAG` / `LEAD`.

```python
Expr.shift(n: int = 1, *, fill_value: Any = None) -> Expr
```

#### Parameters
- **`n`** (`int`, default `1`): Number of rows to shift. Positive shifts fetch preceding rows; negative shifts fetch succeeding rows.
- **`fill_value`** (optional): Value used to replace nulls for boundary rows.

---

### `Expr.diff`

Computes the difference between the current value and the value `n` rows prior: `self - self.shift(n)`.

```python
Expr.diff(n: int = 1) -> Expr
```

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
