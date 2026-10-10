---
title: DateTime Namespace (Expr.dt)
description: Extracting date and time components and truncating timestamps.
---

Temporal methods are accessed through the `.dt` namespace property on date or timestamp expressions (`col("ts").dt.<method>()`).

### Date Components

- **`Expr.dt.year()`**: Extract calendar year as integer.
- **`Expr.dt.quarter()`**: Extract calendar quarter (1 to 4).
- **`Expr.dt.month()`**: Extract calendar month (1 to 12).
- **`Expr.dt.week()`**: Extract ISO week number (1 to 53).
- **`Expr.dt.day()`**: Extract day of month (1 to 31).
- **`Expr.dt.weekday()`**: Extract day of week (Monday = 1).
- **`Expr.dt.ordinal_day()`**: Extract day of the year (1 to 366).

---

### Time Components

- **`Expr.dt.hour()`**: Extract hour (0 to 23).
- **`Expr.dt.minute()`**: Extract minute (0 to 59).
- **`Expr.dt.second()`**: Extract second (0 to 59).

---

### Date Truncation (`.truncate()`)

Truncates a timestamp to a specified calendar interval unit (e.g. `"year"`, `"month"`, `"day"`, `"hour"`).

```python
Expr.dt.truncate(unit: str) -> Expr
```

---

### Example
```python
>>> import workhouse as wh
>>> from workhouse import col
>>> df = wh.from_dict({"order_date": ["2026-10-09", "2026-12-25"]})
>>> df.lazy().with_columns(
...     d=col("order_date").cast("date")
... ).select(
...     year=col("d").dt.year(),
...     month=col("d").dt.month(),
...     quarter=col("d").dt.quarter(),
...     day=col("d").dt.day()
... ).collect().show()
┌──────┬───────┬─────────┬─────┐
│ year │ month │ quarter │ day │
│ i64  │ i64   │ i64     │ i64 │
├──────┼───────┼─────────┼─────┤
│ 2026 │ 10    │ 4       │ 9   │
│ 2026 │ 12    │ 4       │ 25  │
└──────┴───────┴─────────┴─────┘
```
