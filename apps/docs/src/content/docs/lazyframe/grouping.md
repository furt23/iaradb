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
- **`*aggs`**: Aggregation expressions (e.g. `F.col("x").sum()`).
- **`**named`**: Aggregation expressions aliased automatically.

#### Example
```python
>>> import iara
>>> from iara import functions as F
>>> df = iara.from_dict({
...     "category": ["Book", "Electronics", "Book", "Electronics"],
...     "price": [15.0, 300.0, 25.0, 150.0],
...     "units": [4, 1, 2, 2],
... })
>>> summary = (
...     df.lazy()
...     .group_by("category")
...     .agg(
...         total_revenue=(F.col("price") * F.col("units")).sum(),
...         avg_price=F.col("price").mean(),
...         order_count=F.len(),
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
>>> df = iara.from_dict({"val": [10.0, 20.0, 30.0]})
>>> df.lazy().agg(
...     total=F.col("val").sum(),
...     avg=F.col("val").mean(),
...     max=F.col("val").max()
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
- `F.sum(name)` or `F.col(name).sum()`: Total sum of non-null values.
- `F.mean(name)` or `F.col(name).mean()`: Arithmetic average.
- `F.min(name)` or `F.col(name).min()`: Minimum value.
- `F.max(name)` or `F.col(name).max()`: Maximum value.
- `F.count()` or `F.col(name).count()`: Count of rows or non-null values.
- `F.len()`: Row count.
- `F.col(name).n_unique()`: Number of distinct values.
- `F.col(name).std(ddof=1)`: Sample standard deviation.
- `F.col(name).var(ddof=1)`: Sample variance.
- `F.col(name).median()`: Median value.
- `F.col(name).first()` / `F.col(name).last()`: First or last encountered value.
- `F.col(name).filter(predicate).sum()`: Filtered aggregate.
