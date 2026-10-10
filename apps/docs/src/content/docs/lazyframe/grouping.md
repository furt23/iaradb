---
title: LazyFrame Grouping & Aggregations
description: Grouping and computing aggregated metrics across columns.
---

### `LazyFrame.group_by`

Groups the LazyFrame by one or more keys to perform aggregations via `.agg()`.

```python
LazyFrame.group_by(*keys: Any) -> GroupBy
```

*Alias: `groupby`*

#### Parameters
- **`*keys`**: Column names or grouping expressions.

#### Returns
- **`GroupBy`**: An intermediate grouping object supporting `.agg()`.

---

### `GroupBy.agg`

Computes aggregations over each group.

```python
GroupBy.agg(*aggs: Any, **named: Any) -> LazyFrame
```

#### Parameters
- **`*aggs`**: Aggregation expressions (e.g. `col("x").sum()`).
- **`**named`**: Aggregation expressions aliased automatically.

#### Example
```python
>>> import workhouse as wh
>>> from workhouse import col
>>> df = wh.from_dict({
...     "category": ["Book", "Electronics", "Book", "Electronics"],
...     "price": [15.0, 300.0, 25.0, 150.0],
...     "units": [4, 1, 2, 2],
... })
>>> summary = (
...     df.lazy()
...     .group_by("category")
...     .agg(
...         total_revenue=(col("price") * col("units")).sum(),
...         avg_price=col("price").mean(),
...         order_count=wh.len(),
...     )
...     .sort("category")
...     .collect()
... )
>>> summary.show()
┌─────────────┬───────────────┬───────────┬─────────────┐
│ category    │ total_revenue │ avg_price │ order_count │
│ utf8        │ f64           │ f64       │ u64         │
├─────────────┼───────────────┼───────────┼─────────────┤
│ Book        │ 110.0         │ 20.0      │ 2           │
│ Electronics │ 600.0         │ 225.0     │ 2           │
└─────────────┴───────────────┴───────────┴─────────────┘
```

---

### `LazyFrame.agg` (Global Aggregation)

Applies aggregations across the entire frame without grouping keys, producing a single-row result.

```python
LazyFrame.agg(*aggs: Any, **named: Any) -> LazyFrame
```

#### Example
```python
>>> df = wh.from_dict({"val": [10.0, 20.0, 30.0]})
>>> df.lazy().agg(
...     total=col("val").sum(),
...     avg=col("val").mean(),
...     max=col("val").max()
... ).collect().show()
┌───────┬──────┬──────┐
│ total │ avg  │ max  │
│ f64   │ f64  │ f64  │
├───────┼──────┼──────┤
│ 60.0  │ 20.0 │ 30.0 │
└───────┴──────┴──────┘
```

---

### Common Aggregation Functions

The following functions can be used inside `.agg()`:
- `wh.sum(name)` or `col(name).sum()`: Total sum of non-null values.
- `wh.mean(name)` or `col(name).mean()`: Arithmetic average.
- `wh.min(name)` or `col(name).min()`: Minimum value.
- `wh.max(name)` or `col(name).max()`: Maximum value.
- `wh.count()` or `col(name).count()`: Count of rows or non-null values.
- `wh.len()`: Row count.
- `col(name).n_unique()`: Number of distinct values.
- `col(name).std(ddof=1)`: Sample standard deviation.
- `col(name).var(ddof=1)`: Sample variance.
- `col(name).median()`: Median value.
- `col(name).first()` / `col(name).last()`: First or last encountered value.
- `col(name).filter(predicate).sum()`: Filtered aggregate.
