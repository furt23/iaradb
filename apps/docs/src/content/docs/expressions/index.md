---
title: Column Expressions (Expr)
description: Constructing column references, literals, and wildcard expressions.
---

In Workhouse, an `Expr` represents a lazily evaluated computation over columns and rows. Expressions compile into vectorized Apache Arrow execution kernels. The functions that build them live in the `workhouse.functions` module, imported as `F` in these docs (`sum`, `min`, `max`, `all` and `len` are aggregates there, so import the module rather than `*`).

```python
import workhouse
from workhouse import functions as F
```

---

### `F.col`

Constructs an expression referencing a column by name. Passing `"*"` references all columns; passing multiple names returns a list of expressions.

```python
F.col(name: str, *more: str) -> Expr | list[Expr]
```

#### Example
```python
>>> F.col("price")
<Expr col(price)>
>>> F.col("a", "b", "c")
[<Expr col(a)>, <Expr col(b)>, <Expr col(c)>]
>>> F.col("*")
<Expr wildcard(*)>
```

---

### `F.lit`

Constructs a literal constant expression. Python numbers, strings, booleans, dates, and timestamps are converted to Arrow scalar constants.

```python
F.lit(value: Any) -> Expr
```

#### Example
```python
>>> F.lit(42)
<Expr lit(42)>
>>> F.lit("active")
<Expr lit(active)>
```

---

### `F.all`

Returns a wildcard expression selecting all columns. Equivalent to `F.col("*")`.

```python
F.all() -> Expr
```

---

## Expression Categories

- [**Operators & Predicates**](/expressions/operators/): Arithmetic, logical boolean operations, null checks, casts, and aliases.
- [**Aggregations**](/expressions/aggregations/): `sum`, `mean`, `min`, `max`, `count`, `n_unique`, `std`, `var`, `median`.
- [**Math Functions**](/expressions/math/): `abs`, `round`, `sqrt`, `exp`, `log`, `floor`, `ceil`, `pow`.
- [**String Namespace (str)**](/expressions/strings/): Substring matching, pattern checks, casing, trimming, slicing.
- [**DateTime Namespace (dt)**](/expressions/datetime/): Extracting date parts (year, month, day), time parts (hour, minute), truncation.
- [**Conditionals (when/then)**](/expressions/conditionals/): Multi-branch if/else `when(cond).then(...).otherwise(...)`.
