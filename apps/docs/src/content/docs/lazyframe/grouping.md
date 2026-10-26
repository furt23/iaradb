---
title: LazyFrame Grouping & Aggregations
description: Grouping and computing aggregated metrics across columns.
---

## How it works

`group_by()` only records the keys. The work happens in `agg()`, which runs a hash aggregation. Each worker thread folds the rows it reads into its own table of groups, and the tables are merged at the end. Key values are interned into dense ids, so the lookup stays cheap with many keys. When there are many groups compared to rows, the rows are partitioned by hash and each partition is folded in turn. Under the memory limit (see [Execution](/lazyframe/execution/)), partitions that do not fit are spilled to disk.

Rows with a null key form one group: null is a value of the key. Aggregates ignore nulls in their input, except the row counts (`F.len()` and `F.count()`), which count rows. The groups come out in no defined order, so sort the result when the order matters. `agg()` without keys (`LazyFrame.agg`) always returns one row: on an empty input the counts are 0 and the sums are null. A grouped `agg()` on an empty input returns no rows.

Counts are `Int64`. `sum()` over integers is `Int64` and is an error when the total does not fit. `mean()`, `median()`, `std()` and `var()` are `Float64`.

## Methods

### `LazyFrame.group_by`

Groups the LazyFrame by one or more keys to perform aggregations via `.agg()`. A key is a column name or an expression; an expression key is named after the expression (for example `lower(x)`).

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

Computes aggregations over each group. The output has one row per group: the key columns first, then the aggregates in the order given.

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
shape: (2, 4)
+-------------+---------------+-----------+-------------+
| category    | total_revenue | avg_price | order_count |
+-------------+---------------+-----------+-------------+
| Book        | 110.0         | 20.0      | 2           |
| Electronics | 600.0         | 225.0     | 2           |
+-------------+---------------+-----------+-------------+
```

#### Example: Null Keys and Counts
```python
>>> g = iara.from_dict({"k": ["a", None, "a"], "v": [1, None, None]})
>>> g.lazy().group_by("k").agg(
...     rows=F.len(), non_null=F.col("v").count(), total=F.col("v").sum()
... ).sort("k").collect().show()
shape: (2, 4)
+---+------+----------+-------+
| k | rows | non_null | total |
+---+------+----------+-------+
|   | 1    | 0        |       |
| a | 2    | 1        | 1     |
+---+------+----------+-------+
```

---

### `LazyFrame.agg` (Global Aggregation)

Applies aggregations across the entire frame without grouping keys, producing a single-row result, also when the frame is empty.

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
shape: (1, 3)
+-------+------+------+
| total | avg  | max  |
+-------+------+------+
| 60.0  | 20.0 | 30.0 |
+-------+------+------+
```

---

### Common Aggregation Functions

The following functions can be used inside `.agg()`:
- `F.sum(name)` or `F.col(name).sum()`: Total sum of non-null values, as `Int64` for integers. Null when there are no non-null values.
- `F.mean(name)` or `F.col(name).mean()`: Arithmetic average of non-null values, as `Float64`.
- `F.min(name)` or `F.col(name).min()`: Minimum value.
- `F.max(name)` or `F.col(name).max()`: Maximum value.
- `F.count()`: Count of rows, nulls included (`count(*)`).
- `F.col(name).count()`: Count of non-null values. 0 when all values are null, not null.
- `F.len()`: Row count, the same as `F.count()`.
- `F.col(name).n_unique()`: Number of distinct non-null values.
- `F.col(name).std(ddof=1)`: Standard deviation, `Float64`: sample for `ddof=1` (divided by n - 1), population for `ddof=0`. Null when there are too few values: fewer than two for the sample form, none for the population form. Any `ddof` other than 1 gives the population form.
- `F.col(name).var(ddof=1)`: Variance, same rules as `std`.
- `F.col(name).median()`: Median of the non-null values, `Float64`: the mean of the two middle values for an even count. The median is exact and keeps every non-null value of each group in memory.
- `F.col(name).first()` / `F.col(name).last()`: First or last non-null value. The choice depends on the order the rows reach the aggregate; a parallel scan does not fix that order, so sort first when it matters.
- `F.col(name).filter(predicate).sum()`: Filtered aggregate. `F.col(name).sum().filter(predicate)` gives the same result.
