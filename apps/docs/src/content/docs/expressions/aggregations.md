---
title: Expression Aggregations
description: Column-level aggregations and conditional aggregate filtering.
---

Aggregation methods calculate summary values over groups or entire frames.

## How it works

An aggregate reduces the rows of each group, or of the whole frame when there are no group keys, to one value. Nulls are skipped: `sum`, `mean`, `min`, `max`, `median`, `std`, `var`, `first` and `last` consider only the non-null values. `F.count()` and `F.len()` count rows, nulls included, while `Expr.count()` counts the non-null values.

When no value is left, most aggregates return null. `count` and `n_unique` return 0 instead. `count` is Int64. `sum` of integers is Int64 and of unsigned integers UInt64. `mean`, `median`, `std`, `var`, `product` and `quantile` return Float64 for numeric input. An aggregate without group keys over an empty frame still returns one row.

### Numeric Aggregates

#### `Expr.sum`
Returns the arithmetic sum of non-null values. Integers give Int64, unsigned integers UInt64, and floats Float64. A group with no non-null values gives null, not 0.
```python
>>> F.col("revenue").sum()
```

#### `Expr.mean` / `Expr.avg`
Returns the arithmetic mean of non-null values, always as Float64: the mean of `1, 2, 3` is `2.0`.
```python
>>> F.col("latency_ms").mean()
```

#### `Expr.min` / `Expr.max`
Returns the minimum or maximum value. Works on numbers, text and dates; text is compared as strings. NaN sorts above every other float, so `max` returns NaN when any value is NaN, and `min` returns NaN only when every value is NaN.
```python
>>> F.col("temperature").min()
>>> F.col("temperature").max()
```

#### `Expr.median`
Returns the 50th percentile (median) value. With an even number of values it is the mean of the two middle values, so the median of `1, 2, 3, 4` is `2.5`. The result is Float64.
```python
>>> F.col("salary").median()
```

#### `Expr.quantile`
`quantile(q, interpolation="linear")` returns the value at fraction `q` (between 0 and 1) of the non-null values. `"linear"` interpolates between the two nearest values, so `quantile(0.3)` of `1, 2, 3, 4` is `1.9`. `"disc"` returns one of the existing values, the first whose cumulative share reaches `q`, so `quantile(0.5, "disc")` of `1, 2, 3, 4` is `2.0`. The result is Float64, except that `"disc"` keeps the input type. A `q` outside 0 to 1 raises `ValueError`.
```python
>>> F.col("latency_ms").quantile(0.95)
```

---

### Counting & Uniqueness

#### `Expr.count`
Counts the number of non-null values in the column: 0 when there are none. `F.count()` and `F.len()` count rows instead, nulls included.
```python
>>> F.col("user_id").count()
```

#### `Expr.n_unique`
Counts the number of distinct, unique non-null values. Null is not counted as a value.
```python
>>> F.col("country").n_unique()
```

---

### Statistical Variance

#### `Expr.std`
Returns sample standard deviation (`ddof=1` by default) or population standard deviation (`ddof=0`). With one non-null value the sample result is null, and the population result is 0.0. Only `ddof` 0 and 1 are meaningful: any other value gives the population result.
```python
>>> F.col("measurement").std()
```

#### `Expr.var`
Returns sample variance (`ddof=1` by default) or population variance (`ddof=0`), with the same rules as `std`.
```python
>>> F.col("measurement").var()
```

#### Example
```python
>>> iara.from_dict({"x": [1.0, None, 3.0]}).lazy().agg(
...     n_rows=F.len(),
...     n_values=F.col("x").count(),
...     total=F.col("x").sum(),
...     avg=F.col("x").mean(),
...     sd=F.col("x").std(),
...     sd_pop=F.col("x").std(ddof=0),
... ).collect().show()
shape: (1, 6)
+--------+----------+-------+-----+--------------------+--------+
| n_rows | n_values | total | avg | sd                 | sd_pop |
+--------+----------+-------+-----+--------------------+--------+
| 3      | 2        | 4.0   | 2.0 | 1.4142135623730951 | 1.0    |
+--------+----------+-------+-----+--------------------+--------+
```

---

### Positional Value Aggregates

#### `Expr.first` / `Expr.last`
Returns the first or last non-null value encountered in the group. Nulls are skipped, so a null first row is passed over. The engine does not guarantee the input order of a parallel scan: sort the frame first when a specific row must be the first or the last.
```python
>>> F.col("event_type").first()
>>> F.col("event_type").last()
```

---

### Boolean & Product Aggregates

#### `Expr.product`
Returns the product of the non-null values as Float64. Null when there are none.

#### `Expr.all` / `Expr.any`
`all` is true when every non-null value is true, and `any` when at least one is. Both are null when there are no non-null values.

#### `F.count_if`
`F.count_if(condition)` counts the rows where `condition` is true. It is 0 when no row matches.

---

### Filtered Aggregations (`.filter()`)

The `.filter()` method restricts an aggregate calculation to rows matching a boolean predicate without affecting the rest of the query.

Works both as `F.col("x").sum().filter(p)` and `F.col("x").filter(p).sum()`.

A null predicate counts as false. Rows that fail the predicate are still read, but they do not take part in the aggregate. If no row matches, `sum` is null and `count` is 0.

```python
>>> import iara
>>> from iara import functions as F
>>> df = iara.from_dict({
...     "amount": [10.0, 50.0, 100.0, 20.0],
...     "status": ["OK", "FAILED", "OK", "OK"],
... })
>>> df.lazy().agg(
...     total_ok=F.col("amount").sum().filter(F.col("status") == "OK"),
...     count_failed=F.len().filter(F.col("status") == "FAILED")
... ).collect().show()
┌──────────┬──────────────┐
│ total_ok │ count_failed │
│ f64      │ i64          │
├──────────┼──────────────┤
│ 130.0    │ 1            │
└──────────┴──────────────┘
```
