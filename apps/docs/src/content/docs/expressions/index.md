---
title: Column Expressions (Expr)
description: Constructing column references, literals, and wildcard expressions.
---

## How it works

An `Expr` is a description of a computation, not a value. `F.col("price") * 1.2` builds a small tree and holds no data. Nothing runs until the frame is collected (`collect()`, `show()`, a write). The engine then evaluates each expression on a batch of rows at a time, as whole Arrow arrays, so an operator handles a batch in one call rather than one row at a time. The optimizer may rewrite the tree before it runs, but the result is the same as evaluating it as written.

Most functions and operators return null when an input is null. Result types follow from the inputs: mixed integer and float operands give Float64, `/` on integers gives Float64, and functions such as `sqrt`, `exp` and `round` return Float64. Integer `+`, `-` and `*` wrap around on overflow instead of raising an error. The branches of `when` and the arguments of `coalesce` are unified to a common type, but text and numbers do not unify.

In `select`, `group_by` and `sort`, a Python string is a column name. Anywhere else, such as `then("gold")`, a string is a literal. An unknown column name is not checked when the expression is built. It fails when the plan is built, with a `Column not found` error that lists the available columns.

---

### `F.col`

Constructs an expression referencing a column by name. Passing `"*"` references all columns; passing multiple names returns a list of expressions.

```python
F.col(name: str, *more: str) -> Expr | list[Expr]
```

The name is resolved when the plan is built, not when the expression is written. In a `select`, the wildcard `"*"` expands to every column of the frame.

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

The Arrow type of the literal follows the Python type: `int` is Int64 (UInt64 above the Int64 range), `float` is Float64, `bool` is Boolean, `str` is Utf8, `bytes` is Binary, `datetime.date` is Date, and `decimal.Decimal` is a decimal. A naive `datetime.datetime` is stored as given, with no time zone; an aware one is converted to UTC first. `None` gives a null literal.

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

In a `select`, it keeps every column of the frame.

---

## Expression Categories

- [**Operators & Predicates**](/expressions/operators/): Arithmetic, logical boolean operations, null checks, casts, and aliases.
- [**Aggregations**](/expressions/aggregations/): `sum`, `mean`, `min`, `max`, `count`, `n_unique`, `std`, `var`, `median`.
- [**Math Functions**](/expressions/math/): `abs`, `round`, `sqrt`, `exp`, `log`, `floor`, `ceil`, `pow`.
- [**String Namespace (str)**](/expressions/strings/): Substring matching, pattern checks, casing, trimming, slicing.
- [**DateTime Namespace (dt)**](/expressions/datetime/): Extracting date parts (year, month, day), time parts (hour, minute), truncation.
- [**Conditionals (when/then)**](/expressions/conditionals/): Multi-branch if/else `when(cond).then(...).otherwise(...)`.
