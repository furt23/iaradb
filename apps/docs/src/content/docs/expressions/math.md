---
title: Expression Math Functions
description: Scalar mathematical and trigonometric functions.
---

Mathematical functions operate element-wise across expressions.

### `Expr.abs`
Computes the absolute value.
```python
>>> F.col("delta").abs()
```

### `Expr.round`
Rounds to the specified number of decimal places (default `0`).
```python
>>> F.col("price").round(2)
```

### `Expr.floor` / `Expr.ceil`
Rounds down (`floor`) or up (`ceil`) to the nearest integer.
```python
>>> F.col("score").floor()
>>> F.col("score").ceil()
```

### `Expr.sqrt`
Computes the square root.
```python
>>> F.col("area").sqrt()
```

### `Expr.pow`
Raises the expression to a specified power or exponent.
```python
>>> F.col("radius").pow(2)
```

### `Expr.exp`
Computes the exponential function $e^x$.
```python
>>> F.col("val").exp()
```

### `Expr.log` / `Expr.log10`
Computes the natural logarithm (`ln`) or base-10 logarithm (`log10`).
```python
>>> F.col("x").log()
>>> F.col("x").log10()
```

---

### Example
```python
>>> import iara
>>> from iara import functions as F
>>> df = iara.from_dict({"val": [-4.5, 9.0, 16.25]})
>>> df.lazy().select(
...     original=F.col("val"),
...     absolute=F.col("val").abs(),
...     rounded=F.col("val").round(0),
...     root=F.col("val").abs().sqrt(),
... ).collect().show()
┌──────────┬──────────┬─────────┬──────┐
│ original │ absolute │ rounded │ root │
│ f64      │ f64      │ f64     │ f64  │
├──────────┼──────────┼─────────┼──────┤
│ -4.5     │ 4.5      │ -5.0    │ 2.12 │
│ 9.0      │ 9.0      │ 9.0     │ 3.0  │
│ 16.25    │ 16.25    │ 16.0    │ 4.03 │
└──────────┴──────────┴─────────┴──────┘
```
