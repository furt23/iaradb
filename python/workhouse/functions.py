"""Expression functions: columns, literals, conditions and aggregates.

Import the module under a short name; frames, readers and ``sql`` are on
``workhouse`` itself::

    import workhouse
    from workhouse import functions as F

    (
        workhouse.scan_parquet("data/orders")
        .filter(F.col("o_totalprice") > 1000)
        .group_by("o_orderpriority")
        .agg(orders=F.count(), revenue=F.sum("o_totalprice"))
    )

``sum``, ``min``, ``max``, ``all`` and ``len`` are aggregates here, so a
``from workhouse.functions import *`` would hide Python's own: import the
module, or the names you need.
"""

from __future__ import annotations

from typing import Any, overload

from workhouse import Expr, PyExpr, _col_or_expr, _column, _expr, _flatten, _window
from workhouse._structs import struct, struct_literal

__all__ = [
    "all",
    "coalesce",
    "col",
    "concat_list",
    "concat_str",
    "count",
    "count_if",
    "greatest",
    "least",
    "len",
    "lit",
    "max",
    "mean",
    "min",
    "now",
    "pi",
    "rand",
    "row_number",
    "struct",
    "struct_literal",
    "sum",
    "when",
]


@overload
def col(name: str) -> Expr: ...
@overload
def col(name: str, *more: str) -> list[Expr]: ...
def col(name: str, *more: str) -> Any:
    """Reference a column (several names -> list of expressions; "*" -> all)."""
    if more:
        return [col(n) for n in (name, *more)]
    return _column(name)


def all() -> Expr:  # noqa: A001
    return Expr(PyExpr.wildcard())


def lit(value: Any) -> Expr:
    return Expr(PyExpr.lit(value))


def count_if(condition: Any) -> Expr:
    """Number of rows where `condition` is true (nulls and false are skipped):
    0 for a group with none, as Polars counts (SQL `count_if` gives NULL, as DuckDB)."""
    return coalesce(Expr(_expr(condition)._e.agg("count_if")), lit(0))


def now() -> Expr:
    """The current timestamp (UTC, no time zone): one value for the whole query."""
    return Expr(PyExpr.func("now", []))


def pi() -> Expr:
    return Expr(PyExpr.func("pi", []))


def rand(seed: int | None = None, key: Any = None) -> Expr:
    """Uniform random floats in [0, 1), one per row.

    No seed: different on every run. With `seed`: reproducible when batches
    are processed in order. With `seed` and `key` (an integer column): a pure
    function of (seed, key), reproducible whatever the execution order.
    """
    if seed is None:
        if key is not None:
            raise ValueError("`key` needs a `seed`")
        return Expr(PyExpr.func("random", []))
    args = [lit(seed)._e] + ([_expr(key)._e] if key is not None else [])
    return Expr(PyExpr.func("random", args))


def count() -> Expr:
    """count(*) - number of rows."""
    return Expr(PyExpr.count_star().alias("count"))


def len() -> Expr:  # noqa: A001
    return Expr(PyExpr.count_star().alias("len"))


def sum(name: str | Expr) -> Expr:  # noqa: A001
    return _col_or_expr(name).sum()


def mean(name: str | Expr) -> Expr:
    return _col_or_expr(name).mean()


def min(name: str | Expr) -> Expr:  # noqa: A001
    return _col_or_expr(name).min()


def max(name: str | Expr) -> Expr:  # noqa: A001
    return _col_or_expr(name).max()


def row_number() -> Expr:
    """1-based row position (per group with `.over(...)`)."""
    return Expr(_window.row_number())


def coalesce(*exprs: Any) -> Expr:
    return Expr(PyExpr.func("coalesce", [_col_or_expr(e)._e for e in _flatten(exprs)]))


def greatest(*exprs: Any) -> Expr:
    return Expr(PyExpr.func("greatest", [_col_or_expr(e)._e for e in _flatten(exprs)]))


def least(*exprs: Any) -> Expr:
    return Expr(PyExpr.func("least", [_col_or_expr(e)._e for e in _flatten(exprs)]))


def concat_list(*exprs: Any) -> Expr:
    """Join lists (and plain values, as one-element lists) into one list per row.

    A null list makes the result null (Polars).
    """
    return Expr(PyExpr.func("concat_list", [_col_or_expr(e)._e for e in _flatten(exprs)]))


def concat_str(*exprs: Any, separator: str = "") -> Expr:
    items = [_col_or_expr(e) for e in _flatten(exprs)]
    args: list[PyExpr] = []
    for i, e in enumerate(items):
        if i and separator:
            args.append(PyExpr.lit(separator))
        args.append(e._e)
    return Expr(PyExpr.func("concat", args))


class _When:
    def __init__(self, whens: list[tuple[PyExpr, PyExpr]], cond: PyExpr) -> None:
        self._whens = whens
        self._cond = cond

    def then(self, value: Any) -> _Then:
        return _Then(self._whens + [(self._cond, _expr(value)._e)])


class _Then(Expr):
    __slots__ = ("_whens",)

    def __init__(self, whens: list[tuple[PyExpr, PyExpr]]) -> None:
        super().__init__(PyExpr.case(whens, None))
        self._whens = whens

    def when(self, condition: Any) -> _When:
        return _When(self._whens, _expr(condition)._e)

    def otherwise(self, value: Any) -> Expr:
        return Expr(PyExpr.case(self._whens, _expr(value)._e))


def when(condition: Any) -> _When:
    """`when(cond).then(a).when(cond2).then(b).otherwise(c)`."""
    return _When([], _expr(condition)._e)
