"""Window functions for the expression API: windowing via `over`, plus
`rank`, `shift`, `diff`, `cum_*` and `rolling_*`.

Window expressions without `over()` run over the whole frame, in its row
order; `over(partition_by, order_by=...)` evaluates them per group.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Sequence

from ._iara import PyExpr

if TYPE_CHECKING:
    from . import Expr

#: `(units, start, end)`: units "rows" | "range" | "groups"; offsets are
#: relative to the current row (negative = preceding, None = unbounded)
Frame = tuple[str, "int | None", "int | None"]

_RUNNING: Frame = ("rows", None, 0)
_REVERSED: Frame = ("rows", 0, None)


def _as_list(x: Any) -> list[Any]:
    if x is None:
        return []
    if isinstance(x, (list, tuple)):
        return [i for v in x for i in _as_list(v)]
    return [x]


def _per_key(flag: bool | Sequence[bool], n: int) -> list[bool]:
    return [flag] * n if isinstance(flag, bool) else list(flag)


def _keep_nulls(value: PyExpr, x: PyExpr) -> PyExpr:
    """`value` where `x` is not null, null elsewhere."""
    return PyExpr.case([(x.is_not_null(), value)], None)


class WindowMethods:
    """Mixed into `Expr`, which provides `_e`, `_new`, `_key` and `_value`."""

    __slots__ = ()

    def over(
        self,
        partition_by: Any = None,
        *more_by: Any,
        order_by: Any = None,
        descending: bool | Sequence[bool] = False,
        nulls_last: bool | Sequence[bool] = False,
        frame: Frame | None = None,
    ) -> Expr:
        """Evaluate the aggregations / window functions in this expression per group.

        `col("x").sum().over("g")` broadcasts each group's sum to its rows,
        `(col("x") - col("x").mean()).over("g")` demeans per group, and
        `order_by` sets the row order of order-dependent functions
        (`shift`, `cum_sum`, `rank`, `rolling_*`, ...).
        """
        parts = [self._key(p) for p in _as_list([partition_by, *more_by])]
        keys = [self._key(o) for o in _as_list(order_by)]
        n = keys.__len__()
        e = self._e.over(parts, keys, _per_key(descending, n), _per_key(nulls_last, n), frame)
        return self._new(e)

    # ---- ranking ---------------------------------------------------------
    def rank(self, method: str = "average", *, descending: bool = False) -> Expr:
        """Rank of each value; nulls get a null rank.

        method: "average" | "min" | "max" | "dense" | "ordinal".
        """
        key, desc = [self._e], [descending]

        def w(name: str, *args: PyExpr) -> PyExpr:
            return PyExpr.window(name, list(args), key, desc)

        if method == "ordinal":
            r = w("row_number")
        elif method == "min":
            r = w("rank")
        elif method == "dense":
            r = w("dense_rank")
        elif method in ("max", "average"):
            # rows up to the current one and its peers
            r = w("count")
            if method == "average":
                r = w("rank").binary("+", r).cast("float64", True).binary("/", PyExpr.lit(2.0))
        else:
            raise ValueError(f"unknown rank method {method!r} (expected average, min, max, dense or ordinal)")
        return self._new(_keep_nulls(r, self._e))

    # ---- offsets ---------------------------------------------------------
    def shift(self, n: int = 1, *, fill_value: Any = None) -> Expr:
        """Value `n` rows before (negative `n`: after) the current row."""
        args = [self._e, PyExpr.lit(n)]
        if fill_value is not None:
            args.append(self._value(fill_value))
        return self._new(PyExpr.window("lag", args))

    def diff(self, n: int = 1) -> Expr:
        """Difference with the value `n` rows before."""
        return self._new(self._e.binary("-", PyExpr.window("lag", [self._e, PyExpr.lit(n)])))

    # ---- cumulative ------------------------------------------------------
    def _cumulative(self, name: str, reverse: bool) -> PyExpr:
        return PyExpr.window(name, [self._e], [], [], _REVERSED if reverse else _RUNNING)

    def cum_sum(self, *, reverse: bool = False) -> Expr:
        return self._new(_keep_nulls(self._cumulative("sum", reverse), self._e))

    def cum_min(self, *, reverse: bool = False) -> Expr:
        return self._new(_keep_nulls(self._cumulative("min", reverse), self._e))

    def cum_max(self, *, reverse: bool = False) -> Expr:
        return self._new(_keep_nulls(self._cumulative("max", reverse), self._e))

    def cum_count(self, *, reverse: bool = False) -> Expr:
        """Running count of non-null values."""
        return self._new(self._cumulative("count", reverse))

    # ---- rolling ---------------------------------------------------------
    def _rolling(self, name: str, window_size: int, min_periods: int | None, center: bool) -> Expr:
        if window_size < 1:
            raise ValueError("window_size must be at least 1")
        start = -(window_size // 2) if center else -(window_size - 1)
        frame: Frame = ("rows", start, start + window_size - 1)
        agg = PyExpr.window(name, [self._e], [], [], frame)
        count = PyExpr.window("count", [self._e], [], [], frame)
        need = window_size if min_periods is None else min_periods
        return self._new(PyExpr.case([(count.binary(">=", PyExpr.lit(need)), agg)], None))

    def rolling_sum(self, window_size: int, min_periods: int | None = None, *, center: bool = False) -> Expr:
        """Sum over the last `window_size` rows (null until `min_periods` non-null values)."""
        return self._rolling("sum", window_size, min_periods, center)

    def rolling_mean(self, window_size: int, min_periods: int | None = None, *, center: bool = False) -> Expr:
        return self._rolling("mean", window_size, min_periods, center)

    def rolling_min(self, window_size: int, min_periods: int | None = None, *, center: bool = False) -> Expr:
        return self._rolling("min", window_size, min_periods, center)

    def rolling_max(self, window_size: int, min_periods: int | None = None, *, center: bool = False) -> Expr:
        return self._rolling("max", window_size, min_periods, center)

    def rolling_std(
        self, window_size: int, min_periods: int | None = None, *, center: bool = False, ddof: int = 1
    ) -> Expr:
        return self._rolling("std" if ddof == 1 else "stddev_pop", window_size, min_periods, center)

    def rolling_var(
        self, window_size: int, min_periods: int | None = None, *, center: bool = False, ddof: int = 1
    ) -> Expr:
        return self._rolling("var" if ddof == 1 else "var_pop", window_size, min_periods, center)


def row_number() -> PyExpr:
    """1-based position of each row (within its group, once `over()` is applied)."""
    return PyExpr.window("row_number", [])
