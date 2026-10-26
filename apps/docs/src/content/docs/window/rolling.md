---
title: Rolling Window Functions
description: Moving averages, moving sums, and sliding statistical windows.
---

Rolling window functions slide a window of size `window_size` across sorted rows, computing statistics amortized in $O(1)$ time per row using monotonic queues.

## How it works

By default the window ends at the current row and covers the `window_size - 1` rows before it. With `center=True` it covers `window_size // 2` rows before the current row and the rest after it: a window of 4 covers two rows before, the current row and one row after. At the edges of a partition the window is cut short.

A result is null until the window holds at least `min_periods` non-null values. `min_periods` defaults to `window_size`, so with the default, one null in the window makes the result null. With `min_periods=1`, the result is computed over whatever non-null values the window holds.

The engine moves a state along each partition: rows enter at the front of the window and leave at the back. Sums, means and variances update in constant time per row. Min and max keep a deque of candidate positions, which is amortized constant time per row.

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

The result of `rolling_sum` has the dtype of the column when the column is an integer, and `rolling_min` and `rolling_max` keep the column's dtype. `rolling_mean`, `rolling_std` and `rolling_var` return `f64`.

#### Notes
- `rolling_std` and `rolling_var` use `ddof=1` by default (divide by n - 1). `ddof=0` divides by n. Any other `ddof` value behaves as `ddof=0`.
- A variance needs more than `ddof` non-null values in the window. With the default `ddof=1`, a window with one non-null value gives null.
- A `min_periods` above `window_size` never produces a value.

---

### Example: 3-Period Moving Average
```python
>>> import iara
>>> from iara import functions as F
>>> df = iara.from_dict({"stock": ["X", "X", "X", "X"], "close": [10.0, 12.0, 14.0, 16.0]})
>>> df.lazy().with_columns(
...     ma3=F.col("close").rolling_mean(3, min_periods=3).over("stock")
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

### Example: Centered Moving Average
```python
>>> df = iara.from_dict({"x": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]})
>>> df.lazy().with_columns(
...     centered=F.col("x").rolling_mean(3, min_periods=1, center=True),
... ).collect().show()
┌─────┬──────────┐
│ x   │ centered │
│ f64 │ f64      │
├─────┼──────────┤
│ 1.0 │ 1.5      │
│ 2.0 │ 2.0      │
│ 3.0 │ 3.0      │
│ 4.0 │ 4.0      │
│ 5.0 │ 5.0      │
│ 6.0 │ 5.5      │
└─────┴──────────┘
```
