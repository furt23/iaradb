"""The `list` namespace of expressions (`col("x").list.len()`), following Polars.

Every method is a SQL list function of the engine (DuckDB semantics) with
the arguments Polars passes: indexes are 0-based here and translated to the
engine's 1-based ones, and where Polars and DuckDB differ on nulls or empty
lists (`sum` of an empty list is 0 in Polars, NULL in DuckDB) Polars wins.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from workhouse import Expr

_END = 2**62  # a slice end past any list


class ListNamespace:
    __slots__ = ("_x",)

    def __init__(self, x: Expr) -> None:
        self._x = x

    def _f(self, name: str, *args: Any) -> Expr:
        return self._x._f(name, *args)

    # ---- size and access -------------------------------------------------
    def len(self) -> Expr:
        """Number of elements (null for a null list)."""
        return self._f("array_length")

    def get(self, index: Any, *, null_on_oob: bool = True) -> Expr:
        """The element at `index` (0-based; negative counts from the end).

        Out-of-range indexes give null (`null_on_oob` is always on).
        """
        import workhouse as wh

        if isinstance(index, int):
            return self._f("list_extract", index + 1 if index >= 0 else index)
        index = wh.lit(index) if not hasattr(index, "_e") else index
        return self._f("list_extract", wh.when(index >= 0).then(index + 1).otherwise(index))

    def first(self) -> Expr:
        return self.get(0)

    def last(self) -> Expr:
        return self.get(-1)

    def slice(self, offset: int, length: int | None = None) -> Expr:
        """`length` elements from `offset` (0-based; a negative offset counts from the end)."""
        if offset >= 0:
            end = _END if length is None else offset + length
            return self._f("list_slice", offset + 1, end)
        if length is None or offset + length >= 0:
            return self._f("list_slice", offset, _END)
        return self._f("list_slice", offset, offset + length - 1)

    def head(self, n: int = 5) -> Expr:
        return self.slice(0, n)

    def tail(self, n: int = 5) -> Expr:
        return self.slice(-n, n)

    # ---- search ----------------------------------------------------------
    def contains(self, item: Any) -> Expr:
        return self._f("list_contains", item)

    # ---- ordering --------------------------------------------------------
    def sort(self, *, descending: bool = False, nulls_last: bool = False) -> Expr:
        """Sort every list (nulls first unless `nulls_last`, as Polars)."""
        return self._f("list_sort", "DESC" if descending else "ASC", "NULLS LAST" if nulls_last else "NULLS FIRST")

    def reverse(self) -> Expr:
        return self._f("list_reverse")

    def unique(self, *, maintain_order: bool = False) -> Expr:
        """The distinct elements, a null included, in first-seen order."""
        return self._f("list_distinct", "keep_nulls")

    def n_unique(self) -> Expr:
        """Number of distinct elements, a null counting as one."""
        return self.unique().list.len()

    # ---- reductions ------------------------------------------------------
    def _reduce(self, name: str, empty: Any = None) -> Expr:
        import workhouse as wh

        r = self._f(name)
        if empty is None:
            return r
        return wh.when(self._x.is_null()).then(wh.lit(None)).otherwise(r.fill_null(empty))

    def sum(self) -> Expr:
        """Sum of the non-null elements (0 for an empty list)."""
        return self._reduce("list_sum", 0)

    def min(self) -> Expr:
        return self._reduce("list_min")

    def max(self) -> Expr:
        return self._reduce("list_max")

    def mean(self) -> Expr:
        return self._reduce("list_avg")

    def median(self) -> Expr:
        return self._reduce("list_median")

    def join(self, separator: str, *, ignore_nulls: bool = True) -> Expr:
        """Concatenate the elements as text; a null element makes the result null unless `ignore_nulls`."""
        import workhouse as wh

        joined = self._f("array_to_string", separator)
        if ignore_nulls:
            # a list of only nulls joins to '' (the engine's SQL function gives NULL)
            return wh.when(self._x.is_null()).then(wh.lit(None)).otherwise(joined.fill_null(""))
        has_null = self._f("array_length") != self._f("list_count")
        return wh.when(has_null).then(wh.lit(None)).otherwise(joined)
