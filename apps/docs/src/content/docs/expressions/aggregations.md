---
title: Expression Aggregations
description: Column-level aggregations and conditional aggregate filtering.
---

Aggregation methods calculate summary values over groups or entire frames.

### Numeric Aggregates

#### `Expr.sum`
Returns the arithmetic sum of non-null values.
```python
>>> F.col("revenue").sum()
```

#### `Expr.mean` / `Expr.avg`
Returns the arithmetic mean of non-null values.
```python
>>> F.col("latency_ms").mean()
```

#### `Expr.min` / `Expr.max`
Returns the minimum or maximum value.
```python
>>> F.col("temperature").min()
>>> F.col("temperature").max()
```

#### `Expr.median`
Returns the 50th percentile (median) value.
```python
>>> F.col("salary").median()
```

---

### Counting & Uniqueness

#### `Expr.count`
Counts the number of non-null values in the column.
```python
>>> F.col("user_id").count()
```

#### `Expr.n_unique`
Counts the number of distinct, unique non-null values.
```python
>>> F.col("country").n_unique()
```

---

### Statistical Variance

#### `Expr.std`
Returns sample standard deviation (`ddof=1` by default) or population standard deviation (`ddof=0`).
```python
>>> F.col("measurement").std()
```

#### `Expr.var`
Returns sample variance (`ddof=1` by default) or population variance (`ddof=0`).
```python
>>> F.col("measurement").var()
```

---

### Positional Value Aggregates

#### `Expr.first` / `Expr.last`
Returns the first or last non-null value encountered in the group.
```python
>>> F.col("event_type").first()
>>> F.col("event_type").last()
```

---

### Filtered Aggregations (`.filter()`)

The `.filter()` method restricts an aggregate calculation to rows matching a boolean predicate without affecting the rest of the query.

Works both as `F.col("x").sum().filter(p)` and `F.col("x").filter(p).sum()`.

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
│ f64      │ u64          │
├──────────┼──────────────┤
│ 130.0    │ 1            │
└──────────┴──────────────┘
```
