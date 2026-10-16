---
title: LazyFrame Filtering & Slicing
description: Methods for row filtering, slicing, limits, and deduplication.
---

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
┌─────┬────────┐
│ age │ active │
│ i64 │ bool   │
├─────┼────────┤
│ 25  │ true   │
└─────┴────────┘
```

---

### `LazyFrame.limit` / `LazyFrame.head`

Truncates the output to the first `n` rows. Pushes down into table scans where possible.

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
┌─────┐
│ v   │
│ i64 │
├─────┤
│ 10  │
│ 20  │
│ 30  │
└─────┘
```

---

### `LazyFrame.slice`

Extracts a slice of rows starting at `offset` with a given `length`.

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
┌─────┐
│ num │
│ i64 │
├─────┤
│ 200 │
│ 300 │
└─────┘
```

---

### `LazyFrame.unique` / `LazyFrame.distinct`

Deduplicates rows across all projected columns.

```python
LazyFrame.unique() -> LazyFrame
LazyFrame.distinct() -> LazyFrame
```

#### Example
```python
>>> df = iara.from_dict({"tag": ["A", "B", "A", "C", "B"]})
>>> df.lazy().unique().sort("tag").collect().show()
┌──────┐
│ tag  │
│ utf8 │
├──────┤
│ A    │
│ B    │
│ C    │
└──────┘
```
