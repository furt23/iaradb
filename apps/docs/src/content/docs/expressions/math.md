---
title: Expression Math Functions
description: Scalar mathematical and trigonometric functions.
---

## How it works

Mathematical functions operate element-wise across expressions: one output per input row, and a null input gives a null output. They accept integer and float columns. The result types differ: `abs`, `floor` and `ceil` keep an integer input as an integer, while `round`, `sqrt`, `exp`, `log`, `log10` and `pow` always return Float64, even for integers.

Out-of-domain inputs follow IEEE 754 instead of raising an error. `sqrt(-1)` and `ln(-1)` give NaN, `ln(0)` gives negative infinity, and `exp` of a large value gives infinity. Integer overflow is the other case: the absolute value of the smallest int64 wraps to that same negative value.

### `Expr.abs`
Computes the absolute value. Integer types stay integer. The absolute value of the smallest int64 wraps to itself.
```python
>>> F.col("delta").abs()
```

### `Expr.round`
Rounds to the specified number of decimal places (default `0`). Halves are rounded away from zero: `2.5` gives `3.0` and `-2.5` gives `-3.0`. Negative `decimals` round to tens, hundreds and so on, so `round(-2)` of `1234.5` gives `1200.0`. The result is Float64, even for integer input. The rounding is done in binary floating point, as `round(x * 10^d) / 10^d`, so a value stored slightly below a decimal half rounds down: `round(1.005, 2)` gives `1.0`.
```python
>>> F.col("price").round(2)
```

### `Expr.floor` / `Expr.ceil`
Rounds down (`floor`) or up (`ceil`) to the nearest integer. Integer input is returned unchanged in its type, a float input gives a float, and a decimal stays a decimal.
```python
>>> F.col("score").floor()
>>> F.col("score").ceil()
```

### `Expr.sqrt`
Computes the square root as Float64. A negative input gives NaN.
```python
>>> F.col("area").sqrt()
```

### `Expr.pow`
Raises the expression to a specified power or exponent, as a Float64 power: `pow(2)` of `3` is `9.0`. `**` is the same operation. A negative base with a fractional exponent gives NaN.
```python
>>> F.col("radius").pow(2)
```

### `Expr.exp`
Computes the exponential function $e^x$ as Float64. Large inputs overflow to infinity.
```python
>>> F.col("val").exp()
```

### `Expr.log` / `Expr.log10`
Computes the natural logarithm (`ln`) or base-10 logarithm (`log10`). `log` is the natural logarithm, not base 10. `log(0)` is negative infinity, and a negative input gives NaN.
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

### Example: rounding to decimals and tens
```python
>>> iara.from_dict({"x": [2.5, -2.5, 1.005, 1234.5]}).lazy().select(
...     x=F.col("x"),
...     r0=F.col("x").round(0),
...     r2=F.col("x").round(2),
...     r_neg=F.col("x").round(-2),
... ).collect().show()
shape: (4, 4)
+--------+--------+--------+--------+
| x      | r0     | r2     | r_neg  |
+--------+--------+--------+--------+
| 2.5    | 3.0    | 2.5    | 0.0    |
| -2.5   | -3.0   | -2.5   | -0.0   |
| 1.005  | 1.0    | 1.0    | 0.0    |
| 1234.5 | 1235.0 | 1234.5 | 1200.0 |
+--------+--------+--------+--------+
```
