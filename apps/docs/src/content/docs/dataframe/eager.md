---
title: DataFrame Eager Operations
description: Immediate transformations on in-memory DataFrames.
---

### `DataFrame.lazy`

Converts the materialized `DataFrame` back into a `LazyFrame` for further query planning.

```python
DataFrame.lazy() -> LazyFrame
```

#### Example
```python
>>> import workhouse as wh
>>> df = wh.from_dict({"a": [1, 2, 3]})
>>> lf = df.lazy().filter(wh.col("a") > 1)
>>> type(lf)
<class 'workhouse.LazyFrame'>
```

---

### Eager Method Shortcuts

Every transformation available on `LazyFrame` is also provided directly on `DataFrame` as an eager shortcut (internally calling `.lazy().<method>().collect()`):

- **`DataFrame.filter(*predicates)`**: Eagerly filters rows.
- **`DataFrame.select(*exprs, **named)`**: Eagerly projects columns.
- **`DataFrame.with_columns(*exprs, **named)`**: Eagerly adds or updates columns.
- **`DataFrame.sort(by, ...)`**: Eagerly sorts rows.
- **`DataFrame.join(other, ...)`**: Eagerly joins with another frame.
- **`DataFrame.group_by(*keys).agg(*aggs, **named)`**: Eagerly groups and aggregates.
- **`DataFrame.unique()`**: Eagerly deduplicates rows.
- **`DataFrame.sql(query, table_name="self")`**: Eagerly runs SQL against the frame.

#### Example
```python
>>> df = wh.from_dict({"val": [10, 20, 30]})
>>> df.filter(wh.col("val") > 15).show()
┌─────┐
│ val │
│ i64 │
├─────┤
│ 20  │
│ 30  │
└─────┘
```
