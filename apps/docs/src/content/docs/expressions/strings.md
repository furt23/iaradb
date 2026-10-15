---
title: String Namespace (Expr.str)
description: String manipulation, matching, formatting, and slicing.
---

String methods are accessed via the `.str` namespace property on string expressions (`F.col("name").str.<method>()`).

### Pattern Matching

#### `Expr.str.contains`
Tests whether the string contains a literal substring.
```python
Expr.str.contains(pattern: str, literal: bool = True) -> Expr
```

#### `Expr.str.like`
Evaluates SQL `LIKE` wildcard patterns (`%` matches any sequence, `_` matches a single character). Compiled to SIMD prefix/suffix/substring kernels.
```python
Expr.str.like(pattern: str, case_insensitive: bool = False) -> Expr
```

#### `Expr.str.starts_with` / `Expr.str.ends_with`
Checks if the string begins or terminates with a specific prefix or suffix.
```python
Expr.str.starts_with(prefix: str) -> Expr
Expr.str.ends_with(suffix: str) -> Expr
```

---

### Case Conversion & Trimming

#### `Expr.str.to_uppercase` / `Expr.str.to_lowercase`
Converts characters to upper or lower case.
```python
F.col("country").str.to_uppercase()
F.col("email").str.to_lowercase()
```

#### `Expr.str.strip_chars`
Trims leading and trailing whitespace.
```python
F.col("raw_input").str.strip_chars()
```

#### `Expr.str.strip_chars_start` / `Expr.str.strip_chars_end`
Trims leading (`start`) or trailing (`end`) whitespace.
```python
F.col("text").str.strip_chars_start()
F.col("text").str.strip_chars_end()
```

---

### Slicing & Substitution

#### `Expr.str.len_chars`
Returns the character length of each string.
```python
F.col("username").str.len_chars()
```

#### `Expr.str.slice`
Extracts a substring from a 0-based offset with optional length.
```python
Expr.str.slice(offset: int, length: int | None = None) -> Expr
```

#### `Expr.str.head` / `Expr.str.tail`
Returns the first or last `n` characters.
```python
F.col("sku").str.head(3)
F.col("sku").str.tail(4)
```

#### `Expr.str.replace_all`
Replaces all occurrences of `old` with `new`.
```python
Expr.str.replace_all(old: str, new: str) -> Expr
```

#### `Expr.str.reverse`
Reverses the sequence of characters.
```python
F.col("code").str.reverse()
```

---

### Example
```python
>>> import workhouse
>>> from workhouse import functions as F
>>> df = workhouse.from_dict({"city": ["  new york ", "san francisco", "tokyo"]})
>>> df.lazy().select(
...     cleaned=F.col("city").str.strip_chars().str.to_uppercase(),
...     is_san=F.col("city").str.contains("san"),
...     initial=F.col("city").str.strip_chars().str.head(1)
... ).collect().show()
┌───────────────┬────────┬─────────┐
│ cleaned       │ is_san │ initial │
│ utf8          │ bool   │ utf8    │
├───────────────┼────────┼─────────┤
│ NEW YORK      │ false  │ N       │
│ SAN FRANCISCO │ true   │ S       │
│ TOKYO         │ false  │ T       │
└───────────────┴────────┴─────────┘
```
