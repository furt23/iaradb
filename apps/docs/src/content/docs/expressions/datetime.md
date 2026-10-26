---
title: DateTime Namespace (Expr.dt)
description: Extracting date and time components and truncating timestamps.
---

## How it works

A date is stored as days since 1970-01-01 and a timestamp as microseconds since that epoch. Both are wall-clock values: extracting parts and truncating read the stored fields as they are, and no time zone conversion happens. An aware Python datetime is converted to UTC when it becomes a literal, so the `hour()` of `12:00+02:00` is `10`; a naive one is kept as given. Subtracting two dates gives a duration in days.

Null in gives null out. The component functions return Int32. An invalid result, such as a date outside the representable range, is null.

Temporal methods are accessed through the `.dt` namespace property on date or timestamp expressions (`F.col("ts").dt.<method>()`).

### Date Components

- **`Expr.dt.year()`**: Extract calendar year as integer.
- **`Expr.dt.quarter()`**: Extract calendar quarter (1 to 4).
- **`Expr.dt.month()`**: Extract calendar month (1 to 12).
- **`Expr.dt.week()`**: Extract ISO week number (1 to 53). ISO weeks start on Monday, and week 1 is the week that contains the year's first Thursday. Early January can therefore belong to week 52 or 53 of the previous year, and late December to week 1.
- **`Expr.dt.day()`**: Extract day of month (1 to 31).
- **`Expr.dt.weekday()`**: Extract day of week: Monday is 1, Saturday is 6, and Sunday is 0.
- **`Expr.dt.ordinal_day()`**: Extract day of the year (1 to 366).

---

### Time Components

- **`Expr.dt.hour()`**: Extract hour (0 to 23).
- **`Expr.dt.minute()`**: Extract minute (0 to 59).
- **`Expr.dt.second()`**: Extract second (0 to 59). The fraction of a second is dropped.

---

### Date Truncation (`.truncate()`)

Truncates a timestamp to a specified calendar interval unit (e.g. `"year"`, `"month"`, `"day"`, `"hour"`). The result is the start of the unit: `"month"` gives the first day of the month, and `"week"` gives the Monday of the same week. On dates the units are `year`, `quarter`, `month`, `week` and `day`; timestamps also accept `hour`, `minute` and `second`. Any other unit, including `hour` on a date, fails when the query runs.

```python
Expr.dt.truncate(unit: str) -> Expr
```

---

### Other Methods

#### `Expr.dt.offset_by`
Adds a duration string such as `"1d"`, `"-2mo"`, `"1y3mo"` or `"12h"`. Month and year parts move the calendar month, and the day is clamped to the length of the resulting month: `2026-01-31` plus `"1mo"` is `2026-02-28`. A leading `-` negates every part.
```python
Expr.dt.offset_by(by: str) -> Expr
```

#### `Expr.dt.month_start` / `Expr.dt.month_end`
The first and last day of the month of the value.
```python
F.col("d").dt.month_start()
F.col("d").dt.month_end()
```

#### `Expr.dt.strftime`
Formats the value as text with a strftime pattern, such as `"%Y/%m/%d %H:%M"`. `%f` is the microseconds.
```python
Expr.dt.strftime(format: str) -> Expr
```

---

### Example
```python
>>> import iara
>>> from iara import functions as F
>>> df = iara.from_dict({"order_date": ["2026-10-09", "2026-12-25"]})
>>> df.lazy().with_columns(
...     d=F.col("order_date").cast("date")
... ).select(
...     year=F.col("d").dt.year(),
...     month=F.col("d").dt.month(),
...     quarter=F.col("d").dt.quarter(),
...     day=F.col("d").dt.day()
... ).collect().show()
┌──────┬───────┬─────────┬─────┐
│ year │ month │ quarter │ day │
│ i32  │ i32   │ i32     │ i32 │
├──────┼───────┼─────────┼─────┤
│ 2026 │ 10    │ 4       │ 9   │
│ 2026 │ 12    │ 4       │ 25  │
└──────┴───────┴─────────┴─────┘
```

### Example: weekday, ISO week and truncation
```python
>>> iara.from_dict({"d": ["2026-01-04", "2026-10-09"]}).lazy().with_columns(
...     d=F.col("d").cast("date"),
... ).select(
...     d=F.col("d"),
...     weekday=F.col("d").dt.weekday(),
...     week=F.col("d").dt.week(),
...     week_start=F.col("d").dt.truncate("week"),
... ).collect().show()
shape: (2, 4)
+------------+---------+------+------------+
| d          | weekday | week | week_start |
+------------+---------+------+------------+
| 2026-01-04 | 0       | 1    | 2025-12-29 |
| 2026-10-09 | 5       | 41   | 2026-10-05 |
+------------+---------+------+------------+
```
