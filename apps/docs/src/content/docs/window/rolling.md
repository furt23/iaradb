---
title: Rolling Window Functions
description: Moving averages, moving sums, and sliding statistical windows.
---

Rolling window functions slide a window of size `window_size` across sorted rows, computing statistics amortized in $O(1)$ time per row using monotonic queues.

### Methods

- **`Expr.rolling_sum(window_size, min_periods=None, *, center=False)`**: Moving sum.
- **`Expr.rolling_mean(window_size, min_periods=None, *, center=False)`**: Moving average.
- **`Expr.rolling_min(window_size, min_periods=None, *, center=False)`**: Moving minimum.
- **`Expr.rolling_max(window_size, min_periods=None, *, center=False)`**: Moving maximum.
- **`Expr.rolling_std(window_size, min_periods=None, *, center=False, ddof=1)`**: Moving standard deviation.
- **`Expr.rolling_var(window_size, min_periods=None, *, center=False, ddof=1)`**: Moving variance.

#### Parameters
- **`window_size`** (`int`): Number of rows included in the sliding frame.
- **`min_periods`** (`int`, optional): Minimum non-null values required; outputs `null` until this threshold is satisfied.
- **`center`** (`bool`, default `False`): Centers the window around the current row instead of trailing.

---

### Example: 3-Period Moving Average
```python
>>> import workhouse as wh
>>> from workhouse import col
>>> df = wh.from_dict({"stock": ["X", "X", "X", "X"], "close": [10.0, 12.0, 14.0, 16.0]})
>>> df.lazy().with_columns(
...     ma3=col("close").rolling_mean(3, min_periods=3).over("stock")
... ).collect().show()
┌───────┬───────┬──────┐
│ stock │ close │ ma3  │
│ utf8  │ f64   │ f64  │
├───────┼───────┼──────┤
│ X     │ 10.0  │ null │
│ X     │ 12.0  │ null │
│ X     │ 14.0  │ 12.0 │
│ X     │ 16.0  │ 14.0 │
└───────┴───────┴──────┘
```
