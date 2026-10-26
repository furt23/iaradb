---
title: String Namespace (Expr.str)
description: String manipulation, matching, formatting, and slicing.
---

String methods are accessed via the `.str` namespace property on string expressions (`F.col("name").str.<method>()`).

## How it works

The `.str` methods work element-wise and return null for a null input. Positions and lengths count characters (Unicode code points), not bytes, so `"é"` has length 1. Matching is case-sensitive unless a method says otherwise.

`contains` and `replace_all` take a regular expression by default; `literal=True` matches the text as written. `like` uses SQL wildcards, and `starts_with` and `ends_with` compare literal text. Regular expressions use the syntax of the Rust `regex` crate, which has no backreferences or lookaround.

### Pattern Matching

#### `Expr.str.contains`
Tests whether the string matches `pattern`. The pattern is a regular expression unless `literal=True`. A regex match can occur anywhere in the string, so `"san"` matches `"san francisco"`; anchor with `^` and `$` to match the whole string.
```python
Expr.str.contains(pattern: str, literal: bool = False) -> Expr
```

#### `Expr.str.like`
Evaluates SQL `LIKE` wildcard patterns (`%` matches any sequence, including an empty one, and `_` matches a single character). The pattern must match the whole string: `like("ell")` is false for `"Hello"`, and `like("%ell%")` is true. Patterns that use only `%` take a fast path (prefix, suffix and substring search); a `_` uses the general matcher. `case_insensitive=True` gives ILIKE.
```python
Expr.str.like(pattern: str, case_insensitive: bool = False) -> Expr
```

#### `Expr.str.starts_with` / `Expr.str.ends_with`
Checks if the string begins or terminates with a specific prefix or suffix. The comparison is literal and case-sensitive.
```python
Expr.str.starts_with(prefix: str) -> Expr
Expr.str.ends_with(suffix: str) -> Expr
```

---

### Case Conversion & Trimming

#### `Expr.str.to_uppercase` / `Expr.str.to_lowercase`
Converts characters to upper or lower case. Non-ASCII letters are converted too: `é` becomes `É`.
```python
F.col("country").str.to_uppercase()
F.col("email").str.to_lowercase()
```

#### `Expr.str.strip_chars`
Trims leading and trailing whitespace (Unicode whitespace, as in Rust's `str::trim`). Spaces inside the string are kept.
```python
F.col("raw_input").str.strip_chars()
```

#### `Expr.str.strip_chars_start` / `Expr.str.strip_chars_end`
Trims leading (`start`) or trailing (`end`) whitespace only.
```python
F.col("text").str.strip_chars_start()
F.col("text").str.strip_chars_end()
```

---

### Slicing & Substitution

#### `Expr.str.len_chars`
Returns the character length of each string, counted in Unicode code points.
```python
F.col("username").str.len_chars()
```

#### `Expr.str.slice`
Extracts a substring from a 0-based offset with optional length. Without a length, the substring runs to the end of the string. An offset past the end gives an empty string. A negative offset is not counted from the end: `slice(-2)` returns the whole string, so use `tail` for that.
```python
Expr.str.slice(offset: int, length: int | None = None) -> Expr
```

#### `Expr.str.head` / `Expr.str.tail`
Returns the first or last `n` characters. If `n` is longer than the string, the whole string is returned. A negative `n` leaves out that many characters from the other end: `head(-2)` of `"Hello, World"` is `"Hello, Wor"`, and `tail(-2)` is `"llo, World"`.
```python
F.col("sku").str.head(3)
F.col("sku").str.tail(4)
```

#### `Expr.str.replace_all`
Replaces all matches of `pattern` with `value`. `pattern` is a regular expression unless `literal=True`. In regex mode, `$1` (or `${name}`) in `value` inserts the capture group, so `replace_all("(a)", "[$1]")` turns `san` into `s[a]n`.
```python
Expr.str.replace_all(pattern: str, value: str, literal: bool = False) -> Expr
```

#### `Expr.str.reverse`
Reverses the sequence of characters (code points).
```python
F.col("code").str.reverse()
```

---

### Example
```python
>>> import iara
>>> from iara import functions as F
>>> df = iara.from_dict({"city": ["  new york ", "san francisco", "tokyo"]})
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

### Example: regex and literal matching
```python
>>> iara.from_dict({"s": ["san francisco", "New York", None]}).lazy().select(
...     s=F.col("s"),
...     regex=F.col("s").str.contains("s.n"),
...     literal=F.col("s").str.contains("s.n", literal=True),
...     tail_neg=F.col("s").str.tail(-2),
... ).collect().show()
shape: (3, 4)
+---------------+-------+---------+-------------+
| s             | regex | literal | tail_neg    |
+---------------+-------+---------+-------------+
| san francisco | true  | false   | n francisco |
| New York      | false | false   | w York      |
|               |       |         |             |
+---------------+-------+---------+-------------+
```
