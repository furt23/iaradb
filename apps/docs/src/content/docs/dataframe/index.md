---
title: DataFrame Overview
description: In-memory materialized tabular dataset.
---

A `DataFrame` represents a materialized result in memory, backed by Apache Arrow record batches owned by the engine. It provides fast zero-copy conversion to PyArrow, Pandas, and Polars, as well as eager chaining transformations.

```python
import iara
```

## How it works

A `DataFrame` holds a finished result: its schema and a list of Arrow record batches. `iara.from_dict()`, `iara.from_arrow()` and `read_parquet()` return one directly, and `LazyFrame.collect()` produces one from a query. The eager methods on a `DataFrame` run a query over those batches and materialize the output as a new `DataFrame` held in memory, so the input and the result exist in memory at the same time. To run several steps as one query, chain them on `lazy()` and call `collect()` once.

Columns stay in Arrow memory. `to_arrow()` shares the existing buffers instead of copying values; measured on a 10 million row `int64` column, it allocated no new Arrow memory. Conversions to Python objects (`to_pydict()`, `to_dicts()`, `rows()`) create one Python value per cell, so their cost grows with the number of cells.

`schema` reports Arrow type names: `Int64`, `Float64`, `Utf8` (text), `Boolean`, `Null` (a column holding only nulls), and nested types as `List<T>` and `Struct<name: T, ...>`. A Python `None` becomes a null. A null predicate drops the row in `filter()`, a null key never matches in a join, and `unique()` and `group_by()` treat nulls as equal to each other. See [Eager Operations](/dataframe/eager/) for details.

## Quick Example

```python
>>> df = iara.from_dict({"a": [1, 2, 3], "b": [10.5, 20.0, 30.5]})
>>> df.show()
shape: (3, 2)
+---+------+
| a | b    |
+---+------+
| 1 | 10.5 |
| 2 | 20.0 |
| 3 | 30.5 |
+---+------+
```

## Method Categories

- [**Inspection & Properties**](/dataframe/inspection/): `shape`, `height`, `width`, `columns`, `schema`, `show()`, `head()`, `slice()`, `__len__`
- [**Interoperability**](/dataframe/interop/): `to_arrow()`, `to_pandas()`, `to_polars()`, `to_pydict()`, `to_dicts()`, `item()`, `rows()`, `__arrow_c_stream__()`
- [**Export & Writing**](/dataframe/io/): `write_parquet()`, `write_csv()`, `write_ndjson()`, `write_delta()`
- [**Eager Operations**](/dataframe/eager/): `lazy()`, `filter()`, `select()`, `with_columns()`, `sort()`, `join()`, `group_by()`, `unique()`, `sql()`
