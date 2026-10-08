"""Result comparison helpers shared by tests and benchmark validation."""

from __future__ import annotations

import math
from typing import Any

import pyarrow as pa


def _norm(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if hasattr(v, "is_finite") and not isinstance(v, (int, float)):  # decimal.Decimal
        return float(v)
    if hasattr(v, "isoformat"):
        # a timestamp at midnight compares equal to the date
        if hasattr(v, "hour") and (v.hour, v.minute, v.second, v.microsecond) == (0, 0, 0, 0):
            return v.date().isoformat()
        return v.isoformat()
    return v


def _rows(t: pa.Table) -> list[tuple]:
    cols = [t.column(i).to_pylist() for i in range(t.num_columns)]
    return [tuple(_norm(c[r]) for c in cols) for r in range(t.num_rows)]


def _eq(a: Any, b: Any, rtol: float) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return math.isclose(float(a), float(b), rel_tol=rtol, abs_tol=1e-9)
    return a == b


def _sort_key(row: tuple) -> tuple:
    return tuple(
        (0, "") if v is None else (1, round(v, 4)) if isinstance(v, float) else (1, v) for v in row
    )


def diff(result: pa.Table, expected: pa.Table, ordered: bool = True, rtol: float = 1e-6) -> str | None:
    """Return None when equal, else a description of the first difference."""
    if result.num_columns != expected.num_columns:
        return f"column count {result.num_columns} != {expected.num_columns} ({result.column_names} vs {expected.column_names})"
    if result.num_rows != expected.num_rows:
        return f"row count {result.num_rows} != {expected.num_rows}"
    a, b = _rows(result), _rows(expected)

    def first_mismatch(x: list[tuple], y: list[tuple]) -> str | None:
        for i, (ra, rb) in enumerate(zip(x, y)):
            if not all(_eq(p, q, rtol) for p, q in zip(ra, rb)):
                return f"row {i}: {ra} != {rb}"
        return None

    if ordered:
        m = first_mismatch(a, b)
        if m is None:
            return None
    m2 = first_mismatch(sorted(a, key=_sort_key), sorted(b, key=_sort_key))
    if m2 is None:
        return None if not ordered else None if m is None else f"(order differs) {m}"
    return m2
