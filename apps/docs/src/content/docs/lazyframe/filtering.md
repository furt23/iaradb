---
title: LazyFrame Filtering & Slicing
description: Methods for row filtering, slicing, limits, and deduplication.
---

## How it works

A predicate is a boolean expression evaluated on every row. A row is kept only when the predicate is true: a null result drops the row, the same as false. Several predicates passed to one `filter()` call are combined with `AND`. A predicate that is not boolean, such as `F.col("x")` on an integer column, is an error when the step is added.

The optimizer moves filters toward the sources, through projections, sorts, unions and joins, so rows are dropped before the steps above them run. On a Parquet scan, a predicate on the min and max statistics of a column skips whole row groups: a filter that matches one of ten row groups reads one (`row_groups=1/10` in the explain output). The scan also tests the filter columns first while decoding, and decodes the other columns only for the rows that pass. The explain output shows the predicates a scan uses for pruning (`pruning_filters=[...]`).

`limit()`, `head()` and `slice()` are steps that keep rows by position, and they keep the input order. The limit is pushed into the scan when the plan allows it (`fetch=3` in the explain output). A limit placed after a `sort()` becomes a top-k operation instead of a full sort (see [Sorting](/lazyframe/sorting/)).

## Methods

### `LazyFrame.filter`

Filters rows matching one or more boolean predicate expressions. Multiple predicates are combined with logical `AND`.

```python
LazyFrame.filter(*predicates: Any) -> LazyFrame
```

*Alias: `where`*

#### Parameters
- **`*predicates`**: Boolean expressions (or column comparisons).

#### Example
```python
>>> import iara
>>> from iara import functions as F
>>> df = iara.from_dict({"age": [17, 25, 40, 15], "active": [True, True, False, True]})
>>> df.lazy().filter(
...     F.col("age") >= 18,
...     F.col("active") == True
... ).collect().show()
shape: (1, 2)
+-----+--------+
| age | active |
+-----+--------+
| 25  | true   |
+-----+--------+
```

---

### `LazyFrame.limit` / `LazyFrame.head`

Truncates the output to the first `n` rows, in the order the input produces them. The limit is pushed into table scans where possible. `limit(0)` returns an empty frame with the same columns.

```python
LazyFrame.limit(n: int = 5) -> LazyFrame
LazyFrame.head(n: int = 5) -> LazyFrame
```

#### Parameters
- **`n`** (`int`, default `5`): Maximum number of rows to return.

#### Example
```python
>>> df = iara.from_dict({"v": [10, 20, 30, 40, 50]})
>>> df.lazy().limit(3).collect().show()
shape: (3, 1)
+----+
| v  |
+----+
| 10 |
| 20 |
| 30 |
+----+
```

---

### `LazyFrame.slice`

Extracts a slice of rows starting at `offset` with a given `length`. Without a `length`, every row from `offset` to the end is kept. The offset is 0-based and must not be negative (an `OverflowError` is raised); an offset past the end gives an empty frame.

```python
LazyFrame.slice(offset: int, length: int | None = None) -> LazyFrame
```

#### Parameters
- **`offset`** (`int`): Starting 0-based row index.
- **`length`** (`int`, optional): Number of rows to take.

#### Example
```python
>>> df = iara.from_dict({"num": [100, 200, 300, 400, 500]})
>>> df.lazy().slice(1, 2).collect().show()
shape: (2, 1)
+-----+
| num |
+-----+
| 200 |
| 300 |
+-----+
```

---

### `LazyFrame.unique` / `LazyFrame.distinct`

Deduplicates rows across all projected columns. Nulls compare equal here, as in SQL `DISTINCT`: rows that have null in the same columns are duplicates of each other. `distinct()` takes no arguments and is a grouping over every column.

```python
LazyFrame.unique() -> LazyFrame
LazyFrame.distinct() -> LazyFrame
LazyFrame.unique(subset=None, keep="any", maintain_order=False) -> LazyFrame
```

*Alias: `drop_duplicates` (same arguments as `unique`)*

#### Parameters for `unique` with arguments
- **`subset`** (`str | list[str]`, optional): Columns that define a duplicate. Default: all columns.
- **`keep`** (`str`, default `"any"`): Which row of each group of duplicates is kept. `"any"` and `"first"` keep the first row of the input, `"last"` keeps the last, and `"none"` keeps only the rows whose group has exactly one row.
- **`maintain_order`** (`bool`, default `False`): Keep the kept rows in input order. Without it the order of the output is not defined.

With `subset` or any `keep` other than the default, `unique` is computed with a window function (a row number and a group size for each `subset` value), not with the grouping `distinct()` uses. An invalid `keep` raises a `ValueError`.

#### Example
```python
>>> df = iara.from_dict({"tag": ["A", "B", "A", "C", "B"]})
>>> df.lazy().unique().sort("tag").collect().show()
shape: (3, 1)
+-----+
| tag |
+-----+
| A   |
| B   |
| C   |
+-----+
```

```python
>>> df = iara.from_dict({"user": ["a", "b", "a", "c"], "ts": [1, 2, 3, 4]})
>>> df.lazy().unique(subset="user", keep="last", maintain_order=True).collect().show()
shape: (3, 2)
+------+----+
| user | ts |
+------+----+
| b    | 2  |
| a    | 3  |
| c    | 4  |
+------+----+
```
