---
title: Expression Operators & Predicates
description: Vectorized operators, boolean logic, aliases, and casts.
---

### Arithmetic & Comparison Operators

Expressions support standard Python operators that compile to vectorized Arrow kernels:

| Operator | Syntax | Description |
|---|---|---|
| Addition | `a + b` | Vectorized addition |
| Subtraction | `a - b` | Vectorized subtraction |
| Multiplication | `a * b` | Vectorized multiplication |
| True Division | `a / b` | Floating-point division |
| Modulo | `a % b` | Remainder of division |
| Equal | `a == b` | Element-wise equality |
| Not Equal | `a != b` | Element-wise inequality |
| Less Than | `a < b` | Strict less-than comparison |
| Less or Equal | `a <= b` | Less-than or equal comparison |
| Greater Than | `a > b` | Strict greater-than comparison |
| Greater or Equal | `a >= b` | Greater-than or equal comparison |
| Logical AND | `a & b` | Vectorized boolean AND |
| Logical OR | `a \| b` | Vectorized boolean OR |
| Logical NOT | `~a` | Vectorized boolean inversion |
| Negation | `-a` | Numeric negation |

> **Note**: Always use `&` and `|` instead of Python's `and` and `or` keywords, and parenthesize conditions: `(col("a") > 1) & (col("b") < 5)`.

---

### `Expr.alias`

Assigns an output column name to an expression.

```python
Expr.alias(name: str) -> Expr
```

#### Example
```python
>>> (col("price") * 1.20).alias("price_with_tax")
<Expr alias(price_with_tax)>
```

---

### `Expr.cast`

Casts the expression to a specified target data type.

```python
Expr.cast(dtype: str, strict: bool = True) -> Expr
```

#### Parameters
- **`dtype`** (`str`): Target type string, such as `"int32"`, `"int64"`, `"float64"`, `"utf8"`, `"bool"`, `"date"`, or `"timestamp"`.
- **`strict`** (`bool`, default `True`): If `True`, invalid casts raise an error; if `False`, invalid casts produce `null`.

#### Example
```python
>>> col("timestamp_str").cast("date")
```

---

### Null Handling

#### `Expr.is_null`
Returns `True` where the expression is null.
```python
>>> col("address").is_null()
```

#### `Expr.is_not_null`
Returns `True` where the expression is not null.
```python
>>> col("phone").is_not_null()
```

#### `Expr.fill_null`
Replaces null values with a fallback default value (internally using `coalesce`).
```python
>>> col("discount").fill_null(0.0)
```

---

### Membership & Range Predicates

#### `Expr.is_in`
Tests whether values belong to a given collection or list of expressions.
```python
>>> col("country").is_in(["US", "CA", "MX"])
```

#### `Expr.is_between` / `Expr.between`
Tests whether values fall within an inclusive range `[lower, upper]`.
```python
>>> col("score").is_between(80, 100)
```
