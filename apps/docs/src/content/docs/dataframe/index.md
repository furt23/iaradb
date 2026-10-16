---
title: DataFrame Overview
description: In-memory materialized tabular dataset.
---

A `DataFrame` represents a materialized result in memory, backed by Apache Arrow record batches owned by the engine. It provides fast zero-copy conversion to PyArrow, Pandas, and Polars, as well as eager chaining transformations.

```python
import iara
```

## Quick Example

```python
>>> df = iara.from_dict({"a": [1, 2, 3], "b": [10.5, 20.0, 30.5]})
>>> df.show()
┌─────┬──────┐
│ a   │ b    │
│ i64 │ f64  │
├─────┼──────┤
│ 1   │ 10.5 │
│ 2   │ 20.0 │
│ 3   │ 30.5 │
└─────┴──────┘
```

## Method Categories

- [**Inspection & Properties**](/dataframe/inspection/): `shape`, `height`, `width`, `columns`, `schema`, `show()`, `head()`, `slice()`, `__len__`
- [**Interoperability**](/dataframe/interop/): `to_arrow()`, `to_pandas()`, `to_polars()`, `to_pydict()`, `to_dicts()`, `item()`, `rows()`, `__arrow_c_stream__()`
- [**Export & Writing**](/dataframe/io/): `write_parquet()`, `write_csv()`
- [**Eager Operations**](/dataframe/eager/): `lazy()`, `filter()`, `select()`, `with_columns()`, `sort()`, `join()`, `group_by()`, `unique()`, `sql()`
