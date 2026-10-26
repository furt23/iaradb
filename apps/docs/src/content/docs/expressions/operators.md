---
title: Expression Operators & Predicates
description: Vectorized operators, boolean logic, aliases, and casts.
---

## How it works

Comparisons and arithmetic return null when either side is null. The boolean operators `&`, `|` and `~` use three-valued (Kleene) logic: `False & null` is `False`, `True | null` is `True`, and every other combination with a null is null. Their operands must be boolean. Python's `&` binds more tightly than `==` and `<`, so each comparison needs its own parentheses.

Integer `+`, `-` and `*` wrap around at 64 bits, so `max + 1` is the smallest int64, and unary `-` of the smallest int64 is that same value. `/` always returns a float, so `7 / 2` is `3.5`. `%` takes the sign of the divisor (`-7 % 3` is `2`), and an integer remainder by zero raises an error.

Casts are strict by default: a value that cannot be converted raises an error. `strict=False` turns such values into null.

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

An expression without an alias takes the name of its root column, so `col("x") + 1` is named `x`. Two unaliased expressions on the same column therefore produce duplicate names.

#### Example
```python
>>> (col("price") * 1.20).alias("price_with_tax")
<Expr alias(price_with_tax)>
>>> iara.from_dict({"x": [1]}).lazy().select(F.col("x") + 1, F.col("x") * 2).collect().columns
['x', 'x']
```

---

### `Expr.cast`

Casts the expression to a specified target data type.

```python
Expr.cast(dtype: str, strict: bool = True) -> Expr
```

Each value is converted to `dtype`. With `strict=True`, a value that cannot be converted raises an error, such as the text `"abc"` cast to `int64`, or a number outside the target range. With `strict=False`, such values become null. A float cast to an integer is rounded half to even, not truncated: `2.5` becomes `2`, `3.5` becomes `4`, and `-7.9` becomes `-8`. Text cast to `date` or `timestamp` is parsed when it is in ISO form, such as `2026-10-09` or `2026-10-09 13:45:30`.

#### Parameters
- **`dtype`** (`str`): Target type string, such as `"int32"`, `"int64"`, `"float64"`, `"utf8"`, `"bool"`, `"date"`, or `"timestamp"`.
- **`strict`** (`bool`, default `True`): If `True`, invalid casts raise an error; if `False`, invalid casts produce `null`.

#### Example
```python
>>> col("timestamp_str").cast("date")
```

#### Example: rounding on integer casts
```python
>>> iara.from_dict({"x": [2.5, 3.5, -7.9, None]}).lazy().select(
...     F.col("x"), rounded=F.col("x").cast("int64"), text=F.col("x").cast("utf8")
... ).collect().show()
shape: (4, 3)
+------+---------+------+
| x    | rounded | text |
+------+---------+------+
| 2.5  | 2       | 2.5  |
| 3.5  | 4       | 3.5  |
| -7.9 | -8      | -7.9 |
|      |         |      |
+------+---------+------+
```

---

### Null Handling

#### `Expr.is_null`
Returns `True` where the expression is null. A NaN is not null; use `is_nan` to test for NaN.
```python
>>> col("address").is_null()
```

#### `Expr.is_not_null`
Returns `True` where the expression is not null.
```python
>>> col("phone").is_not_null()
```

#### `Expr.fill_null`
Replaces null values with a fallback default value (internally using `coalesce`). The result type is the common type of both sides, so filling an integer column with `0.5` gives Float64.
```python
>>> col("discount").fill_null(0.0)
```

#### `Expr.eq_missing` / `Expr.ne_missing`
Equality in which null equals null: two nulls compare `True`, and a null against a value compares `False`. The `==` operator returns null in both cases. `ne_missing` is the negation.
```python
>>> col("discount").eq_missing(None)
```

---

### Membership & Range Predicates

#### `Expr.is_in`
Tests whether values belong to a given collection or list of expressions. The items can be Python values or expressions. A null value gives null. If the list contains a null and the value matches nothing, the result is null rather than `False`, as in SQL. An empty list gives `False`.
```python
>>> col("country").is_in(["US", "CA", "MX"])
```

#### `Expr.is_between` / `Expr.between`
Tests whether values fall within an inclusive range `[lower, upper]`. It is `(self >= lower) & (self <= upper)`, so a null value gives null.
```python
>>> col("score").is_between(80, 100)
```
