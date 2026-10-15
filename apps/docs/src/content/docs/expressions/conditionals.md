---
title: Conditional Expressions (when / then / otherwise)
description: Multi-branch if-then-else expressions in Iara.
---

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
- Each `.then(value)` specifies the result if the preceding condition is true.
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
