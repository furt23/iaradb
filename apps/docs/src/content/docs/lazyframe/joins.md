---
title: LazyFrame Joins & Set Operations
description: Joining and unioning multiple LazyFrames.
---

## How it works

A join with equality keys is a hash join. One input is built into a hash table and the other is streamed past it (the probe side). The engine estimates the row count of each input from the scan metadata and simple filter selectivity guesses, and builds the smaller one. Either way the output columns are the left columns followed by the right columns. A hash join keeps the row order of the probe side. When the build side does not fit in the memory limit, the join is partitioned and spilled to disk.

Null keys never match: a null on either side finds no partner. A left join therefore keeps a left row with a null key, with nulls in the right columns. Joins need equality keys (`on`, or `left_on` and `right_on`), except `how="cross"`, which pairs every row of the left side with every row of the right side.

Output columns follow fixed rules. For `inner` and `left` joins, the right key columns are not repeated in the output: the left key is the one kept. For `right` and `full` joins, the right key columns are kept, and the left key is null on rows that have no left match. A right column whose name is already used on the left gets `suffix` appended. For `semi` and `anti` joins, the output has the left columns only.

`union()` is `UNION ALL`: it keeps duplicates and matches columns by position, not by name. The output takes the names of the first frame. Column types are unified: integers and floats give `Float64`, and an integer column with a string column is an error. `union()` needs the same number of columns in every frame.

## Methods

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
  - `"cross"`: Cartesian product of all rows. `on`, `left_on` and `right_on` are not used.
- **`left_on`** (`str | list[str]`, optional): Join key(s) in left frame.
- **`right_on`** (`str | list[str]`, optional): Join key(s) in right frame.
- **`suffix`** (`str`, default `"_right"`): Column name suffix for disambiguating duplicated names.

#### Example: Inner Join
```python
>>> import iara
>>> users = iara.from_dict({"user_id": [1, 2, 3], "name": ["Alice", "Bob", "Charlie"]})
>>> orders = iara.from_dict({"order_id": [101, 102], "cust_id": [1, 2], "amt": [50.0, 75.0]})
>>> joined = users.lazy().join(orders.lazy(), left_on="user_id", right_on="cust_id")
>>> joined.collect().show()
shape: (2, 4)
+---------+-------+----------+------+
| user_id | name  | order_id | amt  |
+---------+-------+----------+------+
| 1       | Alice | 101      | 50.0 |
| 2       | Bob   | 102      | 75.0 |
+---------+-------+----------+------+
```

The `cust_id` column is not in the output: the right key of an inner join is dropped, and the left key `user_id` is kept.

#### Example: Same Key Name and Suffix
```python
>>> a = iara.from_dict({"id": [1, 2, 3], "v": [10, 20, 30]})
>>> b = iara.from_dict({"id": [2, 3, 4], "v": [200, 300, 400]})
>>> a.lazy().join(b.lazy(), on="id").collect().show()
shape: (2, 3)
+----+----+---------+
| id | v  | v_right |
+----+----+---------+
| 2  | 20 | 200     |
| 3  | 30 | 300     |
+----+----+---------+
```

With `on="id"` the key is one column in the output. `v` exists on both sides, so the right one is renamed `v_right`.

#### Example: Full Join
```python
>>> a.lazy().join(b.lazy(), on="id", how="full").collect().show()
shape: (4, 4)
+----+----+----------+---------+
| id | v  | id_right | v_right |
+----+----+----------+---------+
| 1  | 10 |          |         |
| 2  | 20 | 2        | 200     |
| 3  | 30 | 3        | 300     |
|    |    | 4        | 400     |
+----+----+----------+---------+
```

In a full join the keys are not merged: `id` is null for the row that exists only on the right, and that row's key is in `id_right`.

#### Example: Semi Join & Anti Join
```python
# Semi join keeps user rows that have orders
>>> users.lazy().join(orders.lazy(), left_on="user_id", right_on="cust_id", how="semi").collect().show()
shape: (2, 2)
+---------+-------+
| user_id | name  |
+---------+-------+
| 1       | Alice |
| 2       | Bob   |
+---------+-------+

# Anti join keeps users with no orders
>>> users.lazy().join(orders.lazy(), left_on="user_id", right_on="cust_id", how="anti").collect().show()
shape: (1, 2)
+---------+---------+
| user_id | name    |
+---------+---------+
| 3       | Charlie |
+---------+---------+
```

#### Example: Null Keys
```python
>>> l = iara.from_dict({"k": [1, None], "x": ["a", "b"]})
>>> r = iara.from_dict({"k": [1, None], "y": ["c", "d"]})
>>> l.lazy().join(r.lazy(), on="k", how="left").collect().show()
shape: (2, 3)
+---+---+---+
| k | x | y |
+---+---+---+
| 1 | a | c |
|   | b |   |
+---+---+---+
```

The null key on the left does not match the null key on the right.

---

### `LazyFrame.union`

Concatenates multiple frames vertically (`UNION ALL`). The columns are matched by position; use `union_by_name()` to match them by name.

```python
LazyFrame.union(*others: LazyFrame | DataFrame) -> LazyFrame
```

#### Parameters
- **`*others`**: One or more frames with matching schemas to concatenate.

#### Example
```python
>>> df1 = iara.from_dict({"val": [1, 2]})
>>> df2 = iara.from_dict({"val": [3, 4]})
>>> df1.lazy().union(df2.lazy()).collect().show()
shape: (4, 1)
+-----+
| val |
+-----+
| 1   |
| 2   |
| 3   |
| 4   |
+-----+
```

#### Example: Union by Name
`union_by_name()` matches the columns by name. A column that a frame lacks is filled with nulls, and the types are unified as in `union()`.

```python
>>> f1 = iara.from_dict({"a": [1], "b": ["x"]})
>>> f2 = iara.from_dict({"b": ["y"], "c": [2.5]})
>>> f1.lazy().union_by_name(f2.lazy()).collect().show()
shape: (2, 3)
+---+---+-----+
| a | b | c   |
+---+---+-----+
| 1 | x |     |
|   | y | 2.5 |
+---+---+-----+
```
