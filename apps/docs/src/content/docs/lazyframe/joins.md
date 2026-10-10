---
title: LazyFrame Joins & Set Operations
description: Joining and unioning multiple LazyFrames.
---

### `LazyFrame.join`

Joins this LazyFrame with another LazyFrame or DataFrame.

```python
LazyFrame.join(
    other: LazyFrame | DataFrame,
    on: Any = None,
    how: str = "inner",
    left_on: Any = None,
    right_on: Any = None,
    suffix: str = "_right"
) -> LazyFrame
```

#### Parameters
- **`other`** (`LazyFrame | DataFrame`): Right-hand dataset to join.
- **`on`** (`str | list[str]`, optional): Column name(s) common to both tables.
- **`how`** (`str`, default `"inner"`): Join type:
  - `"inner"`: Inner join (matches in both).
  - `"left"`: Left outer join (all rows from left).
  - `"right"`: Right outer join (all rows from right).
  - `"full"`: Full outer join (all rows from both).
  - `"semi"`: Semi join (rows from left that have a match on right; no right columns added).
  - `"anti"`: Anti join (rows from left with no match on right; no right columns added).
  - `"cross"`: Cartesian product of all rows.
- **`left_on`** (`str | list[str]`, optional): Join key(s) in left frame.
- **`right_on`** (`str | list[str]`, optional): Join key(s) in right frame.
- **`suffix`** (`str`, default `"_right"`): Column name suffix for disambiguating duplicated names.

#### Example: Inner Join
```python
>>> import workhouse as wh
>>> users = wh.from_dict({"user_id": [1, 2, 3], "name": ["Alice", "Bob", "Charlie"]})
>>> orders = wh.from_dict({"order_id": [101, 102], "cust_id": [1, 2], "amt": [50.0, 75.0]})
>>> joined = users.lazy().join(orders.lazy(), left_on="user_id", right_on="cust_id")
>>> joined.collect().show()
┌─────────┬───────┬──────────┬─────────┬──────┐
│ user_id │ name  │ order_id │ cust_id │ amt  │
│ i64     │ utf8  │ i64      │ i64     │ f64  │
├─────────┼───────┼──────────┼─────────┼──────┤
│ 1       │ Alice │ 101      │ 1       │ 50.0 │
│ 2       │ Bob   │ 102      │ 2       │ 75.0 │
└─────────┴───────┴──────────┴─────────┴──────┘
```

#### Example: Semi Join & Anti Join
```python
# Semi join keeps user rows that have orders
>>> users.lazy().join(orders.lazy(), left_on="user_id", right_on="cust_id", how="semi").collect().show()
┌─────────┬───────┐
│ user_id │ name  │
│ i64     │ utf8  │
├─────────┼───────┤
│ 1       │ Alice │
│ 2       │ Bob   │
└─────────┴───────┘

# Anti join keeps users with no orders
>>> users.lazy().join(orders.lazy(), left_on="user_id", right_on="cust_id", how="anti").collect().show()
┌─────────┬─────────┐
│ user_id │ name    │
│ i64     │ utf8    │
├─────────┼─────────┤
│ 3       │ Charlie │
└─────────┴─────────┘
```

---

### `LazyFrame.union`

Concatenates multiple frames vertically.

```python
LazyFrame.union(*others: LazyFrame | DataFrame) -> LazyFrame
```

#### Parameters
- **`*others`**: One or more frames with matching schemas to concatenate.

#### Example
```python
>>> df1 = wh.from_dict({"val": [1, 2]})
>>> df2 = wh.from_dict({"val": [3, 4]})
>>> df1.lazy().union(df2.lazy()).collect().show()
┌─────┐
│ val │
│ i64 │
├─────┤
│ 1   │
│ 2   │
│ 3   │
│ 4   │
└─────┘
```
