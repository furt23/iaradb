---
title: Conditional Expressions (when / then / otherwise)
description: Multi-branch if-then-else expressions in Iara.
---

## How it works

`when` builds a chain of branches that is checked in order. For each row, the value of the first branch whose condition is true is used. A null condition counts as not true. When no branch matches, the `otherwise` value is used, or null if there is none. The result type is the common type of all the branch values, so `1.5` and `2` give Float64, but text and numbers cannot be mixed in one `when`.

Every branch is evaluated over the whole batch, not only over the rows that take it. An expression that fails on any row fails the query, even when that row takes a different branch. For example, `F.when(F.col("j") != 0).then(F.col("i") % F.col("j")).otherwise(F.lit(-1))` raises a divide-by-zero error for any batch that contains a zero in `j`. Make the divisor itself safe first, for example with `F.when(F.col("j") == 0).then(F.lit(1)).otherwise(F.col("j"))`.

### `F.when`

Constructs a multi-branch `CASE WHEN` conditional expression.

```python
F.when(condition: Any).then(value: Any).when(...).then(...).otherwise(default: Any) -> Expr
```

#### Syntax
```python
F.when(cond1).then(val1).when(cond2).then(val2).otherwise(default_val)
```

- Each `.when(condition)` accepts a boolean expression.
- Each `.then(value)` specifies the result if the preceding condition is true. It accepts an expression or a Python value; a Python string there is a literal, not a column name.
- `.otherwise(value)` provides the fallback default if no condition matches. If omitted, unmatched rows evaluate to `null`.

---

### Example: Tier Categorization
```python
>>> import iara
>>> from iara import functions as F
>>> df = iara.from_dict({
...     "customer": ["Alice", "Bob", "Charlie", "David"],
...     "spend": [1500.0, 450.0, 50.0, 0.0]
... })
>>> df.lazy().with_columns(
...     tier=F.when(F.col("spend") >= 1000.0).then(F.lit("Platinum"))
...          .when(F.col("spend") >= 200.0).then(F.lit("Gold"))
...          .when(F.col("spend") > 0.0).then(F.lit("Silver"))
...          .otherwise(F.lit("Inactive"))
... ).collect().show()
┌──────────┬────────┬──────────┐
│ customer │ spend  │ tier     │
│ utf8     │ f64    │ utf8     │
├──────────┼────────┼──────────┤
│ Alice    │ 1500.0 │ Platinum │
│ Bob      │ 450.0  │ Gold     │
│ Charlie  │ 50.0   │ Silver   │
│ David    │ 0.0    │ Inactive │
└──────────┴────────┴──────────┘
```

### Example: null conditions and no `otherwise`
```python
>>> iara.from_dict({"score": [90, None, 40]}).lazy().with_columns(
...     grade=F.when(F.col("score") >= 80).then(F.lit("pass")).when(F.col("score") < 50).then(F.lit("fail")),
... ).collect().show()
shape: (3, 2)
+-------+-------+
| score | grade |
+-------+-------+
| 90    | pass  |
|       |       |
| 40    | fail  |
+-------+-------+
```
