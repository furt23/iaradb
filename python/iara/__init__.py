"""Iara Engine - a parallel, vectorized query engine written in Rust.

Lazy DataFrame API and SQL on top of the
same optimizer and morsel-driven parallel executor. Data is exchanged with
pyarrow / pandas / polars zero-copy through the Arrow C stream interface.

    >>> import iara
    >>> from iara import functions as F
    >>> (iara.scan_parquet("lineitem/*.parquet")
    ...    .filter(F.col("l_shipdate") <= datetime.date(1998, 9, 2))
    ...    .group_by("l_returnflag", "l_linestatus")
    ...    .agg(F.col("l_quantity").sum().alias("sum_qty"))
    ...    .sort("l_returnflag")
    ...    .collect())
"""

from __future__ import annotations

import contextvars as _contextvars
import datetime as _datetime
import os
from typing import Any, Iterable, Iterator, Mapping, Sequence

from iara._iara import (
    PyDataFrame,
    PyExpr,
    PyLazyFrame,
    PySessionContext,
    QueryCancelled,
    IaraError,
    __version__,
    cancel_query,
    interrupt,
    memory_usage,
    num_threads,
    record_plans,
    running_queries,
    set_memory_limit,
    set_num_threads,
    take_recorded_plans,
)
from iara import _window
from iara import widgets
from iara._lists import ListNamespace
from iara._structs import List, Struct, StructNamespace, StructUnnest
from iara._structs import struct_literal as _struct_literal
from iara._window import WindowMethods
from iara.storage import StorageError, StorageOptions, list_files, set_storage_options, storage_requests
from iara import file_io as _fio
from iara.storage import normalize as _storage

#: the public API: frames, readers, SQL and settings; expression functions
#: (``col``, ``lit``, ``when``, aggregates...) are in ``iara.functions``
__all__ = [
    "Expr",
    "concat",
    "Decimal",
    "LazyFrame",
    "ResultStream",
    "DataFrame",
    "SessionContext",
    "IaraError",
    "QueryCancelled",
    "StorageError",
    "set_storage_options",
    "list_files",
    "storage_requests",
    "interrupt",
    "cancel_query",
    "running_queries",
    "record_plans",
    "take_recorded_plans",
    "Struct",
    "List",
    "scan_parquet",
    "scan_delta",
    "scan_csv",
    "scan_ndjson",
    "scan_json",
    "read_parquet",
    "read_delta",
    "read_csv",
    "read_ndjson",
    "read_json",
    "from_arrow",
    "from_pandas",
    "from_polars",
    "from_dict",
    "sql",
    "preview",
    "workspace",
    "functions",
    "widgets",
    "set_num_threads",
    "num_threads",
    "set_memory_limit",
    "memory_usage",
    "__version__",
]

#: rows ``preview`` shows by default
PREVIEW_ROWS = 500

# data type names accepted by Expr.cast
Boolean = "bool"
Int8, Int16, Int32, Int64 = "int8", "int16", "int32", "int64"
UInt8, UInt16, UInt32, UInt64 = "uint8", "uint16", "uint32", "uint64"
Float32, Float64 = "float32", "float64"
Utf8 = String = "utf8"
Date = "date"
Datetime = "timestamp"


def Decimal(precision: int = 38, scale: int = 9) -> str:  # noqa: N802
    return f"decimal({precision},{scale})"


_DEFAULT_CTX: PySessionContext | None = None


def _ctx() -> PySessionContext:
    global _DEFAULT_CTX
    if _DEFAULT_CTX is None:
        _DEFAULT_CTX = PySessionContext()
    return _DEFAULT_CTX


# ---------------------------------------------------------------------------
# expressions
# ---------------------------------------------------------------------------


def _expr(x: Any) -> Expr:
    """Wrap a Python value as an expression (strings are literals)."""
    if isinstance(x, Expr):
        return x
    if isinstance(x, dict):
        return _struct_literal(x)
    return Expr(PyExpr.lit(x))


def _column(name: str) -> Expr:
    """A column by name ("*": all of them)."""
    return Expr(PyExpr.wildcard()) if name == "*" else Expr(PyExpr.col(name))


def _col_or_expr(x: Any) -> Expr:
    """Strings are column names (used by select / group_by / sort ...)."""
    if isinstance(x, Expr):
        return x
    if isinstance(x, str):
        return _column(x)
    return _expr(x)


def _flatten(items: Iterable[Any]) -> list[Any]:
    out: list[Any] = []
    for i in items:
        if isinstance(i, (list, tuple)):
            out.extend(_flatten(i))
        else:
            out.append(i)
    return out


def _implode(agg: PyExpr) -> Expr:
    """A list aggregate that gives an empty list (not null) for an empty group."""
    return Expr(PyExpr.func("coalesce", [agg, PyExpr.func("list_value", [])]))


def _named(e: Expr) -> PyExpr:
    """Unaliased expressions take their root column name by default."""
    pe = e._e
    if pe.is_alias() or pe.is_column():
        return pe
    root = pe.root_name()
    return pe.alias(root) if root is not None else pe


def _exprs(items: Iterable[Any], named: Mapping[str, Any] | None = None) -> list[PyExpr]:
    out = [_named(_col_or_expr(x)) for x in _flatten(items)]
    if named:
        out.extend(_col_or_expr(v)._e.alias(k) for k, v in named.items())
    return out


class Expr(WindowMethods):
    """A lazily evaluated column expression."""

    __slots__ = ("_e",)

    def __init__(self, e: PyExpr) -> None:
        self._e = e

    @staticmethod
    def _new(e: PyExpr) -> Expr:
        return Expr(e)

    @staticmethod
    def _key(x: Any) -> PyExpr:
        return _col_or_expr(x)._e

    @staticmethod
    def _value(x: Any) -> PyExpr:
        return _expr(x)._e

    def __repr__(self) -> str:
        return f"<Expr {self._e!r}>"

    def __bool__(self) -> bool:
        raise TypeError(
            "the truth value of an Expr is ambiguous; use '&' / '|' instead of 'and' / 'or', "
            "and avoid chained comparisons"
        )

    # ---- operators -------------------------------------------------------
    def _bin(self, op: str, other: Any, reverse: bool = False) -> Expr:
        o = _expr(other)
        if reverse:
            return Expr(o._e.binary(op, self._e))
        return Expr(self._e.binary(op, o._e))

    def __add__(self, o: Any) -> Expr:
        return self._bin("+", o)

    def __radd__(self, o: Any) -> Expr:
        return self._bin("+", o, True)

    def __sub__(self, o: Any) -> Expr:
        return self._bin("-", o)

    def __rsub__(self, o: Any) -> Expr:
        return self._bin("-", o, True)

    def __mul__(self, o: Any) -> Expr:
        return self._bin("*", o)

    def __rmul__(self, o: Any) -> Expr:
        return self._bin("*", o, True)

    def __truediv__(self, o: Any) -> Expr:
        return self._bin("/", o)

    def __rtruediv__(self, o: Any) -> Expr:
        return self._bin("/", o, True)

    def __mod__(self, o: Any) -> Expr:
        """Remainder with the sign of the divisor (Polars); SQL `%` truncates (DuckDB)."""
        return (self._bin("%", o) + o)._bin("%", o)

    def __rmod__(self, o: Any) -> Expr:
        return _expr(o) % self

    def __eq__(self, o: Any) -> Expr:  # type: ignore[override]
        return self._bin("==", o)

    def __ne__(self, o: Any) -> Expr:  # type: ignore[override]
        return self._bin("!=", o)

    def __lt__(self, o: Any) -> Expr:
        return self._bin("<", o)

    def __le__(self, o: Any) -> Expr:
        return self._bin("<=", o)

    def __gt__(self, o: Any) -> Expr:
        return self._bin(">", o)

    def __ge__(self, o: Any) -> Expr:
        return self._bin(">=", o)

    def __and__(self, o: Any) -> Expr:
        return self._bin("and", o)

    def __rand__(self, o: Any) -> Expr:
        return self._bin("and", o, True)

    def __or__(self, o: Any) -> Expr:
        return self._bin("or", o)

    def __ror__(self, o: Any) -> Expr:
        return self._bin("or", o, True)

    def __invert__(self) -> Expr:
        return Expr(self._e.not_())

    def __neg__(self) -> Expr:
        return Expr(self._e.neg())

    def __pos__(self) -> Expr:
        return self

    __hash__ = None  # type: ignore[assignment]

    # ---- general ---------------------------------------------------------
    def alias(self, name: str) -> Expr:
        return Expr(self._e.alias(name))

    def cast(self, dtype: str, strict: bool = True) -> Expr:
        return Expr(self._e.cast(dtype, strict))

    def is_null(self) -> Expr:
        return Expr(self._e.is_null())

    def is_not_null(self) -> Expr:
        return Expr(self._e.is_not_null())

    def is_in(self, values: Iterable[Any]) -> Expr:
        return Expr(self._e.is_in([_expr(v)._e for v in values], False))

    def is_between(self, lower: Any, upper: Any) -> Expr:
        return (self >= lower) & (self <= upper)

    between = is_between

    def fill_null(self, value: Any) -> Expr:
        return Expr(PyExpr.func("coalesce", [self._e, _expr(value)._e]))

    def not_(self) -> Expr:
        return ~self

    # ---- aggregations ----------------------------------------------------
    def sum(self) -> Expr:
        return Expr(self._e.agg("sum"))

    def mean(self) -> Expr:
        return Expr(self._e.agg("mean"))

    avg = mean

    def min(self) -> Expr:
        return Expr(self._e.agg("min"))

    def max(self) -> Expr:
        return Expr(self._e.agg("max"))

    def count(self) -> Expr:
        return Expr(self._e.agg("count"))

    def n_unique(self) -> Expr:
        return Expr(self._e.agg("count", True))

    def std(self, ddof: int = 1) -> Expr:
        return Expr(self._e.agg("std" if ddof == 1 else "stddev_pop"))

    def var(self, ddof: int = 1) -> Expr:
        return Expr(self._e.agg("var" if ddof == 1 else "var_pop"))

    def median(self) -> Expr:
        return Expr(self._e.agg("median"))

    def first(self) -> Expr:
        return Expr(self._e.agg("first"))

    def last(self) -> Expr:
        return Expr(self._e.agg("last"))

    def _agg2(self, name: str, other: Any) -> Expr:
        return Expr(self._e.agg_with(name, [_expr(other)._e]))

    def quantile(self, quantile: float, interpolation: str = "linear") -> Expr:
        """The `quantile` (0..1) of the non-null values.

        "linear" interpolates between the two closest values (Polars default,
        DuckDB `quantile_cont`); "disc" returns an existing value (DuckDB
        `quantile_disc`: the first value whose cumulative share reaches
        `quantile`). Other Polars modes are not supported.
        """
        names = {"linear": "quantile_cont", "disc": "quantile_disc"}
        if interpolation not in names:
            raise ValueError(f"interpolation must be 'linear' or 'disc', got {interpolation!r}")
        if not 0 <= quantile <= 1:
            raise ValueError("quantile must be between 0 and 1")
        return self._agg2(names[interpolation], float(quantile))

    def approx_quantile(self, quantile: float) -> Expr:
        """Like `quantile`, but allowed to approximate. Currently exact."""
        return self._agg2("approx_quantile", float(quantile))

    def product(self) -> Expr:
        """Product of the non-null values (a float); null for no values."""
        return Expr(self._e.agg("product"))

    def all(self) -> Expr:
        """True when every non-null value is true (DuckDB `bool_and`); null for no values."""
        return Expr(self._e.agg("bool_and"))

    def any(self) -> Expr:
        """True when some value is true (DuckDB `bool_or`); null for no values."""
        return Expr(self._e.agg("bool_or"))

    def max_by(self, by: Any) -> Expr:
        """The value on the row where `by` is largest (rows with a null in either are skipped)."""
        return self._agg2("max_by", by)

    def min_by(self, by: Any) -> Expr:
        """The value on the row where `by` is smallest."""
        return self._agg2("min_by", by)

    def corr(self, other: Any) -> Expr:
        """Pearson correlation with `other` over the rows where both are non-null."""
        return self._agg2("corr", other)

    def cov(self, other: Any, ddof: int = 1) -> Expr:
        """Covariance with `other`; `ddof=1` is the sample covariance, 0 the population one."""
        return self._agg2("covar_samp" if ddof == 1 else "covar_pop", other)

    def slope(self, x: Any) -> Expr:
        """Slope of the least-squares fit of this column (y) on `x` (`regr_slope`)."""
        return self._agg2("regr_slope", x)

    def filter(self, predicate: Expr) -> Expr:
        """Restrict an aggregation to rows matching `predicate`.

        Works both as `col("x").sum().filter(p)` and `col("x").filter(p).sum()`.
        """
        if self._e.contains_agg():
            return Expr(self._e.agg_filter(_expr(predicate)._e))
        return _Filtered(self, _expr(predicate))

    # ---- math ------------------------------------------------------------
    def _f(self, name: str, *args: Any) -> Expr:
        return Expr(PyExpr.func(name, [self._e, *(_expr(a)._e for a in args)]))

    def abs(self) -> Expr:
        return self._f("abs")

    def round(self, decimals: int = 0) -> Expr:
        return self._f("round", decimals)

    def sqrt(self) -> Expr:
        return self._f("sqrt")

    def exp(self) -> Expr:
        return self._f("exp")

    def log(self) -> Expr:
        return self._f("ln")

    def log10(self) -> Expr:
        return self._f("log10")

    def floor(self) -> Expr:
        return self._f("floor")

    def ceil(self) -> Expr:
        return self._f("ceil")

    def pow(self, exponent: Any) -> Expr:
        return self._f("power", exponent)

    __pow__ = pow

    def sin(self) -> Expr:
        return self._f("sin")

    def cos(self) -> Expr:
        return self._f("cos")

    def tan(self) -> Expr:
        return self._f("tan")

    def arcsin(self) -> Expr:
        """NaN outside [-1, 1] (Polars); DuckDB raises an error."""
        return self._f("asin")

    def arccos(self) -> Expr:
        return self._f("acos")

    def arctan(self) -> Expr:
        return self._f("atan")

    def arctan2(self, x: Any) -> Expr:
        """Angle of the point (x, self), `atan2(self, x)`."""
        return self._f("atan2", x)

    def degrees(self) -> Expr:
        return self._f("degrees")

    def radians(self) -> Expr:
        return self._f("radians")

    def clip(self, lower_bound: Any = None, upper_bound: Any = None) -> Expr:
        """Limit values to [lower_bound, upper_bound]; None leaves a side open.

        Nulls stay null (Polars).
        """
        return self._f("clip", lower_bound, upper_bound)

    def sign(self) -> Expr:
        """-1, 0 or 1 by the sign of each value (NaN stays NaN)."""
        return self._f("sign")

    def is_nan(self) -> Expr:
        """True for NaN; null stays null."""
        return self._f("isnan")

    def is_not_nan(self) -> Expr:
        return ~self.is_nan()

    def mod(self, other: Any) -> Expr:
        return self % other

    def eq_missing(self, other: Any) -> Expr:
        """Equality where null == null is True and null == value is False."""
        return self._f("eq_null_safe", other)

    def ne_missing(self, other: Any) -> Expr:
        return ~self.eq_missing(other)

    @property
    def str(self) -> _StrNamespace:
        return _StrNamespace(self)

    @property
    def dt(self) -> _DtNamespace:
        return _DtNamespace(self)

    @property
    def list(self) -> ListNamespace:
        """List functions (`col("tags").list.len()`)."""
        return ListNamespace(self)

    @property
    def struct(self) -> StructNamespace:
        """Struct functions (`col("s").struct.field("a")`)."""
        return StructNamespace(self)

    def implode(self) -> Expr:
        """Collect the values of each group (or of the whole column) into one list.

        Nulls are kept and values are listed in table order; no rows give an
        empty list (SQL's `array_agg` gives NULL).
        """
        return _implode(self._e.agg("array_agg"))


class _Filtered(Expr):
    """`col(x).filter(pred)`: only meaningful when followed by an aggregation."""

    __slots__ = ("_base", "_pred")

    def __init__(self, base: Expr, pred: Expr) -> None:
        super().__init__(base._e)
        self._base = base
        self._pred = pred

    def _agg(self, name: str, distinct: bool = False) -> Expr:
        return Expr(self._base._e.agg(name, distinct).agg_filter(self._pred._e))

    def _agg2(self, name: str, other: Any) -> Expr:
        return Expr(self._base._e.agg_with(name, [_expr(other)._e]).agg_filter(self._pred._e))

    def sum(self) -> Expr:
        return self._agg("sum")

    def mean(self) -> Expr:
        return self._agg("mean")

    avg = mean

    def min(self) -> Expr:
        return self._agg("min")

    def max(self) -> Expr:
        return self._agg("max")

    def count(self) -> Expr:
        return self._agg("count")

    def n_unique(self) -> Expr:
        return self._agg("count", True)

    def median(self) -> Expr:
        return self._agg("median")

    def std(self, ddof: int = 1) -> Expr:
        return self._agg("std" if ddof == 1 else "stddev_pop")

    def var(self, ddof: int = 1) -> Expr:
        return self._agg("var" if ddof == 1 else "var_pop")

    def first(self) -> Expr:
        return self._agg("first")

    def last(self) -> Expr:
        return self._agg("last")

    def product(self) -> Expr:
        return self._agg("product")

    def all(self) -> Expr:
        return self._agg("bool_and")

    def any(self) -> Expr:
        return self._agg("bool_or")

    def quantile(self, quantile: float, interpolation: str = "linear") -> Expr:
        return Expr.quantile(self, quantile, interpolation)

    def max_by(self, by: Any) -> Expr:
        return self._agg2("max_by", by)

    def min_by(self, by: Any) -> Expr:
        return self._agg2("min_by", by)

    def implode(self) -> Expr:
        return _implode(self._base._e.agg("array_agg").agg_filter(self._pred._e))


class _StrNamespace:
    __slots__ = ("_x",)

    def __init__(self, x: Expr) -> None:
        self._x = x

    def contains(self, pattern: str, literal: bool = False) -> Expr:
        """True where the string contains `pattern` (a regex unless `literal`)."""
        if literal:
            return self._x._f("contains", pattern)
        return self._x._f("regexp_like", pattern)

    def like(self, pattern: str, case_insensitive: bool = False) -> Expr:
        return Expr(self._x._e.like(pattern, False, case_insensitive))

    def starts_with(self, prefix: str) -> Expr:
        return self._x._f("starts_with", prefix)

    def ends_with(self, suffix: str) -> Expr:
        return self._x._f("ends_with", suffix)

    def to_uppercase(self) -> Expr:
        return self._x._f("upper")

    def to_lowercase(self) -> Expr:
        return self._x._f("lower")

    def len_chars(self) -> Expr:
        return self._x._f("length")

    def len_bytes(self) -> Expr:
        return self._x._f("octet_length")

    def strip_chars(self) -> Expr:
        return self._x._f("trim")

    def strip_chars_start(self) -> Expr:
        return self._x._f("ltrim")

    def strip_chars_end(self) -> Expr:
        return self._x._f("rtrim")

    def slice(self, offset: int, length: int | None = None) -> Expr:
        if length is None:
            return self._x._f("substring", offset + 1)
        return self._x._f("substring", offset + 1, length)

    def head(self, n: int) -> Expr:
        return self._x._f("left", n)

    def tail(self, n: int) -> Expr:
        return self._x._f("right", n)

    def replace_all(self, pattern: str, value: str, literal: bool = False) -> Expr:
        """Replace every match; `value` may use `$1` / `${name}` group references."""
        return self._x._f("regexp_replace", pattern, value, ("l" if literal else "") + "gr")

    def replace(self, pattern: str, value: str, literal: bool = False, n: int = 1) -> Expr:
        """Replace the first `n` matches (Polars); only n=1 or n<0 (all) are supported."""
        if n < 0:
            return self.replace_all(pattern, value, literal)
        if n != 1:
            raise NotImplementedError("str.replace supports n=1 or n=-1 (use replace_all)")
        return self._x._f("regexp_replace", pattern, value, ("l" if literal else "") + "r")

    def extract(self, pattern: str, group_index: int = 1) -> Expr:
        """Capture group `group_index` of the first match (null when nothing matches)."""
        return self._x._f("regexp_extract", pattern, group_index, "n")

    def split(self, by: str, *, inclusive: bool = False) -> Expr:
        """Split on the text `by` into a list of strings (`by` is not a regex)."""
        if inclusive:
            raise NotImplementedError("str.split(inclusive=True) is not supported")
        return self._x._f("string_split", by)

    def count_matches(self, pattern: str, literal: bool = False) -> Expr:
        """Number of non-overlapping matches."""
        return self._x._f("regexp_count", pattern, "l" if literal else "")

    def to_date(self, format: str | None = None, strict: bool = True) -> Expr:
        """Parse to a date; `format` is a strptime pattern. strict=False gives null on failure."""
        if format is None:
            return self._x.cast("date")
        return self._x._f("strptime_date" if strict else "to_date", format)

    def to_datetime(self, format: str | None = None, strict: bool = True) -> Expr:
        """Parse to a timestamp; `format` is a strptime pattern. strict=False gives null on failure."""
        if format is None:
            return self._x.cast("timestamp")
        return self._x._f("strptime" if strict else "to_timestamp", format)

    def pad_start(self, length: int, fill_char: str = " ") -> Expr:
        """Left-pad to `length` chars; longer strings are kept whole (Polars)."""
        from iara.functions import when

        return when(self.len_chars() >= length).then(self._x).otherwise(self._x._f("lpad", length, fill_char))

    def pad_end(self, length: int, fill_char: str = " ") -> Expr:
        """Right-pad to `length` chars; longer strings are kept whole (Polars)."""
        from iara.functions import when

        return when(self.len_chars() >= length).then(self._x).otherwise(self._x._f("rpad", length, fill_char))

    def zfill(self, length: int) -> Expr:
        """Left-pad with zeros, keeping a leading sign in front."""
        return self._x._f("zfill", length)

    def to_titlecase(self) -> Expr:
        return self._x._f("initcap")

    def json_decode(self, dtype: Any = None) -> Expr:
        """Parse JSON text into `dtype` (``iara.Struct({...})``, ``iara.List(..)`` or a scalar type).

        Polars infers the type from the data; a lazy plan needs it up front, so
        `dtype` is required here. Members the type does not name are ignored and
        absent ones are null; a value of the wrong type is an error.
        """
        if dtype is None:
            raise TypeError(
                "str.json_decode needs dtype=..: the engine types the whole plan before it runs, "
                "e.g. dtype=iara.Struct({'a': 'int64', 'tags': iara.List('utf8')})"
            )
        return self._x._f("from_json", str(dtype))

    def json_path_match(self, json_path: str) -> Expr:
        """The value at `json_path` (``$.a.b[0]``) as a string; null when absent."""
        return self._x._f("json_extract_string", json_path)

    def reverse(self) -> Expr:
        return self._x._f("reverse")


class _DtNamespace:
    __slots__ = ("_x",)

    def __init__(self, x: Expr) -> None:
        self._x = x

    def year(self) -> Expr:
        return self._x._f("year")

    def quarter(self) -> Expr:
        return self._x._f("quarter")

    def month(self) -> Expr:
        return self._x._f("month")

    def week(self) -> Expr:
        return self._x._f("week")

    def day(self) -> Expr:
        return self._x._f("day")

    def weekday(self) -> Expr:
        return self._x._f("dayofweek")

    def ordinal_day(self) -> Expr:
        return self._x._f("dayofyear")

    def hour(self) -> Expr:
        return self._x._f("hour")

    def minute(self) -> Expr:
        return self._x._f("minute")

    def second(self) -> Expr:
        return self._x._f("second")

    def truncate(self, unit: str) -> Expr:
        return Expr(PyExpr.func("date_trunc", [PyExpr.lit(unit), self._x._e]))

    def strftime(self, format: str) -> Expr:
        """Format as text with a strftime pattern (`%f` = microseconds)."""
        return self._x._f("strftime", format)

    def offset_by(self, by: str) -> Expr:
        """Shift by a duration string such as "1d", "-2mo", "1y3mo" or "12h"."""
        return self._x._f("offset_by", by)

    def month_start(self) -> Expr:
        return self._x._f("month_start")

    def month_end(self) -> Expr:
        return self._x._f("month_end")


# ---------------------------------------------------------------------------
# frames
# ---------------------------------------------------------------------------


class LazyFrame:
    """A lazy query. Nothing runs until `.collect()`."""

    __slots__ = ("_lf",)

    def __init__(self, lf: PyLazyFrame) -> None:
        self._lf = lf

    # ---- schema ----------------------------------------------------------
    @property
    def columns(self) -> list[str]:
        return self._lf.columns()

    @property
    def schema(self) -> dict[str, str]:
        return dict(self._lf.schema())

    def __repr__(self) -> str:
        return f"<LazyFrame columns={self.columns}>\n" + self.explain(optimized=False)

    # ---- transformations -------------------------------------------------
    def filter(self, *predicates: Any) -> LazyFrame:
        preds = [_expr(p) for p in _flatten(predicates)]
        if not preds:
            return self
        p = preds[0]
        for q in preds[1:]:
            p = p & q
        return LazyFrame(self._lf.filter(p._e))

    where = filter

    def _expand_unnests(self, exprs: Iterable[Any]) -> list[Any]:
        """`struct.unnest()` items become one expression per field."""
        out: list[Any] = []
        for item in _flatten(exprs):
            out.extend(item.expand(self._lf) if isinstance(item, StructUnnest) else [item])
        return out

    def select(self, *exprs: Any, **named: Any) -> LazyFrame:
        return LazyFrame(self._lf.select(_exprs(self._expand_unnests(exprs), named)))

    def with_columns(self, *exprs: Any, **named: Any) -> LazyFrame:
        return LazyFrame(self._lf.with_columns(_exprs(self._expand_unnests(exprs), named)))

    with_column = with_columns

    def group_by(self, *keys: Any) -> GroupBy:
        return GroupBy(self, [_col_or_expr(k)._e for k in _flatten(keys)])

    groupby = group_by

    def agg(self, *aggs: Any, **named: Any) -> LazyFrame:
        """Global aggregation (no grouping keys)."""
        return LazyFrame(self._lf.group_by_agg([], _exprs(aggs, named)))

    def join(
        self,
        other: LazyFrame | DataFrame,
        on: Any = None,
        how: str = "inner",
        left_on: Any = None,
        right_on: Any = None,
        suffix: str = "_right",
    ) -> LazyFrame:
        other_lf = other.lazy() if isinstance(other, DataFrame) else other
        if how == "cross":
            return LazyFrame(self._lf.join(other_lf._lf, [], [], "cross", suffix))
        if on is not None:
            left_on = right_on = on
        if left_on is None or right_on is None:
            raise ValueError("join requires `on` or both `left_on` and `right_on`")
        lk = [_col_or_expr(x)._e for x in _flatten([left_on])]
        rk = [_col_or_expr(x)._e for x in _flatten([right_on])]
        return LazyFrame(self._lf.join(other_lf._lf, lk, rk, how, suffix))

    def sort(
        self,
        by: Any,
        *more_by: Any,
        descending: bool | Sequence[bool] = False,
        nulls_last: bool | Sequence[bool] = False,
    ) -> LazyFrame:
        keys = [_col_or_expr(k)._e for k in _flatten([by, *more_by])]
        n = keys.__len__()
        desc = [descending] * n if isinstance(descending, bool) else list(descending)
        nl = [nulls_last] * n if isinstance(nulls_last, bool) else list(nulls_last)
        return LazyFrame(self._lf.sort(keys, desc, nl))

    def limit(self, n: int = 5) -> LazyFrame:
        return LazyFrame(self._lf.slice(0, n))

    head = limit

    def slice(self, offset: int, length: int | None = None) -> LazyFrame:
        return LazyFrame(self._lf.slice(offset, length))

    def unique(self) -> LazyFrame:
        return LazyFrame(self._lf.distinct())

    distinct = unique

    def drop(self, *columns: str) -> LazyFrame:
        return LazyFrame(self._lf.drop(_flatten(columns)))

    def explode(self, columns: Any, *more: Any) -> LazyFrame:
        """One row per element of the list columns, in place of the lists.

        Several columns are exploded together (the shorter lists padded with
        nulls). A null or empty list gives one row with null (Polars).
        """
        names = [c if isinstance(c, str) else _col_or_expr(c)._e.output_name() for c in _flatten([columns, *more])]
        return LazyFrame(self._lf.explode(names))

    def unnest(self, columns: Any, *more: Any, separator: str | None = None) -> LazyFrame:
        """Struct columns replaced by one column per field, in place (Polars).

        With `separator`, fields are named ``column{separator}field``.
        """
        names = [c if isinstance(c, str) else _col_or_expr(c)._e.output_name() for c in _flatten([columns, *more])]
        return LazyFrame(self._lf.unnest(names, separator))

    def rename(self, mapping: Mapping[str, str]) -> LazyFrame:
        return LazyFrame(self._lf.rename(list(mapping.items())))

    def union(self, *others: LazyFrame | DataFrame) -> LazyFrame:
        lfs = [(o.lazy() if isinstance(o, DataFrame) else o)._lf for o in _flatten(others)]
        return LazyFrame(self._lf.union(lfs))

    def sql(self, query: str, table_name: str = "self", params: Any = None) -> LazyFrame:
        """Run SQL against this frame (referenced as `self` by default).
        ``params`` binds the query's placeholders: a list or tuple for ``$1``,
        ``$2`` / ``?``, a dict for ``:name`` / ``$name``."""
        ctx = PySessionContext()
        ctx.register_lazy(table_name, self._lf)
        return LazyFrame(ctx.sql(query, params))

    # ---- execution -------------------------------------------------------
    def explain(self, optimized: bool = True) -> str:
        return self._lf.explain(optimized)

    def explain_tree(self) -> dict[str, Any]:
        """The physical plan as nested dicts: `{name, detail, role, children}`."""
        return self._lf.plan_tree()

    def collect(self) -> DataFrame:
        return DataFrame(self._lf.collect())

    def preview(self, n: int = PREVIEW_ROWS) -> None:
        """Show the first ``n`` rows (runs the query with a limit); see :func:`preview`."""
        preview(self, n)

    def analyze(self) -> dict[str, Any]:
        """Run the query measuring every operator (the result is streamed and
        only counted): ``{plan, profile, rows, requests}``. ``plan`` is
        ``explain_tree()`` with a ``metrics`` dict on each node (``rows_out``,
        ``elapsed_ms``, ``batches``, and ``memory_peak`` / ``spilled_bytes`` when
        the operator held memory or spilled; times are summed over threads),
        ``profile`` is what ``profile()`` returns, ``requests`` the object store
        requests made."""
        return self._lf.analyze()

    def profile(self) -> tuple[DataFrame, dict[str, Any]]:
        """Collect, also returning the run profile: `{id, elapsed_ms, cancelled,
        memory_peak, spilled_bytes, pipelines: [{source, operators, sink,
        morsels_total, morsels_done, rows_in, rows_out, elapsed_ms, finished}],
        pending: [{source, sink, morsels}]}`. ``pending`` lists the pipelines
        planned and not started yet (``morsels`` is ``None`` when only the run
        knows it); the queue is approximate when the run diverges from the plan
        (a spill, a recursive CTE)."""
        df, prof = self._lf.collect_profiled()
        return DataFrame(df), prof

    def fetch(self, n: int = 5) -> DataFrame:
        return self.limit(n).collect()

    def sink_delta(
        self,
        path: str,
        mode: str = "error",
        partition_by: str | Sequence[str] | None = None,
        storage_options: StorageOptions | None = None,
        schema_mode: str | None = None,
    ) -> dict[str, Any]:
        """Write the result to a Delta table (a path or ``s3://`` URL) while it
        is produced, without collecting it. ``mode``: ``"error"`` (the table
        must not exist), ``"append"``, ``"overwrite"`` (replaces the rows; the
        old files stay in the log for time travel) or ``"ignore"`` (no write if
        the table exists). ``partition_by`` applies to a new table; later
        writes keep the table's partitioning. ``schema_mode="merge"`` adds the
        result's new columns to the table on append / overwrite. The data
        files are added by a single commit, so a failing query leaves the table
        as it was. Returns ``{"version", "files", "rows", "skipped"}``."""
        if schema_mode not in (None, "merge"):
            raise ValueError("schema_mode must be None or 'merge'")
        cols = [partition_by] if isinstance(partition_by, str) else list(partition_by or [])
        return self._lf.sink_delta(str(path), mode, cols or None, _storage(storage_options), schema_mode == "merge")

    def sink_parquet(
        self,
        path: str,
        compression: str = "zstd",
        row_group_size: int | None = None,
        storage_options: StorageOptions | None = None,
        partition_by: str | Sequence[str] | None = None,
    ) -> int:
        """Write the result to Parquet (a path or ``s3://`` URL) while it is
        produced, without collecting it; returns the number of rows. With
        ``partition_by``, ``path`` is a folder of Hive-style partitions
        (``year=2024/region=north/part-....parquet``)."""
        cols = [partition_by] if isinstance(partition_by, str) else list(partition_by or [])
        return self._lf.sink_parquet(str(path), compression, row_group_size, _storage(storage_options), cols or None)

    def sink_csv(
        self, path: str, separator: str = ",", include_header: bool = True, storage_options: StorageOptions | None = None
    ) -> int:
        """Write the result to CSV while it is produced; returns the number of rows."""
        return self._lf.sink_csv(str(path), include_header, separator, _storage(storage_options))

    def sink_ndjson(self, path: str, storage_options: StorageOptions | None = None) -> int:
        """Write the result as NDJSON (one object per row) while it is produced;
        returns the number of rows. Numbers and booleans are JSON values, nulls
        are ``null``, every other type (dates, ...) is a string."""
        return self._lf.sink_ndjson(str(path), _storage(storage_options))

    def to_reader(self) -> Any:
        """The result as a ``pyarrow.RecordBatchReader`` that runs the query as it
        is read: results larger than memory can be consumed batch by batch."""
        return self.stream().reader()

    def stream(self) -> ResultStream:
        """Start the query; its result is read once, batch by batch."""
        return ResultStream(self._lf.stream())

    def iter_batches(self) -> Any:
        """Iterate over the result's ``pyarrow.RecordBatch``es as they are produced."""
        yield from self.to_reader()

    def __arrow_c_stream__(self, requested_schema: Any = None) -> Any:
        """A lazy Arrow C stream: ``pa.table(lf)``, ``pl.from_arrow(lf)``, DuckDB
        and file writers read the result while the query runs."""
        return self._lf.stream().__arrow_c_stream__(requested_schema)

    def lazy(self) -> LazyFrame:
        return self


class ResultStream:
    """A running query whose result is read once as Arrow batches; its run
    profile (as in ``LazyFrame.profile``) is known once it was read to the end."""

    __slots__ = ("_s", "_reader")

    def __init__(self, s: Any) -> None:
        self._s = s
        self._reader: Any = None

    def reader(self) -> Any:
        """The result as a ``pyarrow.RecordBatchReader``."""
        import pyarrow as pa

        if self._reader is None:
            self._reader = pa.RecordBatchReader.from_stream(self._s)
        return self._reader

    @property
    def schema(self) -> Any:
        """The result's ``pyarrow.Schema``."""
        return self.reader().schema

    def batches(self) -> Iterator[Any]:
        """The result's ``pyarrow.RecordBatch``es; a failed query raises its own
        error (``QueryCancelled``, ``StorageError`` ...)."""
        try:
            yield from self.reader()
        except Exception:
            self._s.check()
            raise

    def profile(self) -> dict[str, Any] | None:
        return self._s.profile()

    def __arrow_c_stream__(self, requested_schema: Any = None) -> Any:
        return self._s.__arrow_c_stream__(requested_schema)


class GroupBy:
    __slots__ = ("_lf", "_keys")

    def __init__(self, lf: LazyFrame, keys: list[PyExpr]) -> None:
        self._lf = lf
        self._keys = keys

    def agg(self, *aggs: Any, **named: Any) -> LazyFrame:
        return LazyFrame(self._lf._lf.group_by_agg(self._keys, _exprs(aggs, named)))

    def _all(self, method: str) -> LazyFrame:
        key_names = {k.output_name() for k in self._keys}
        cols = [c for c in self._lf.columns if c not in key_names]
        return self.agg(*[getattr(_column(c), method)() for c in cols])

    def sum(self) -> LazyFrame:
        return self._all("sum")

    def mean(self) -> LazyFrame:
        return self._all("mean")

    def min(self) -> LazyFrame:
        return self._all("min")

    def max(self) -> LazyFrame:
        return self._all("max")

    def count(self) -> LazyFrame:
        return self.agg(Expr(PyExpr.count_star().alias("count")))

    def len(self) -> LazyFrame:
        return self.agg(Expr(PyExpr.count_star().alias("len")))


class DataFrame:
    """A materialised result (Arrow record batches owned by the engine)."""

    __slots__ = ("_df",)

    def __init__(self, df: PyDataFrame) -> None:
        self._df = df

    # ---- interop ---------------------------------------------------------
    def __arrow_c_stream__(self, requested_schema: Any = None) -> Any:
        return self._df.__arrow_c_stream__(requested_schema)

    def to_arrow(self) -> Any:
        import pyarrow as pa

        return pa.RecordBatchReader.from_stream(self._df).read_all()

    def to_pandas(self, **kwargs: Any) -> Any:
        import pandas as pd
        import pyarrow as pa

        # dates as datetime64 columns, as Polars converts them, not one Python object per value
        kwargs.setdefault("date_as_object", False)
        # one block per column: numeric columns without NULLs share the Arrow buffers
        kwargs.setdefault("split_blocks", True)
        user_mapper = kwargs.pop("types_mapper", None)

        def types_mapper(t: Any) -> Any:
            mapped = user_mapper(t) if user_mapper else None
            if mapped is None and pa.types.is_decimal(t):
                # exact and zero-copy, not one decimal.Decimal object per value
                return pd.ArrowDtype(t)
            return mapped

        return self.to_arrow().to_pandas(types_mapper=types_mapper, **kwargs)

    def to_polars(self) -> Any:
        import polars as pl

        return pl.from_arrow(self.to_arrow())

    def to_pydict(self) -> dict[str, list[Any]]:
        return self.to_arrow().to_pydict()

    def to_dicts(self) -> list[dict[str, Any]]:
        return self.to_arrow().to_pylist()

    def rows(self) -> list[tuple[Any, ...]]:
        d = self.to_pydict()
        return list(zip(*d.values())) if d else []

    def item(self) -> Any:
        if self.shape != (1, 1):
            raise ValueError(f"item() requires a 1x1 frame, got shape {self.shape}")
        return self.rows()[0][0]

    def __getitem__(self, name: str) -> Any:
        return self.to_arrow().column(name)

    # ---- info ------------------------------------------------------------
    @property
    def shape(self) -> tuple[int, int]:
        return (self._df.num_rows(), self._df.num_columns())

    @property
    def height(self) -> int:
        return self._df.num_rows()

    @property
    def width(self) -> int:
        return self._df.num_columns()

    @property
    def columns(self) -> list[str]:
        return self._df.columns()

    @property
    def schema(self) -> dict[str, str]:
        return dict(self._df.schema())

    def __len__(self) -> int:
        return self._df.num_rows()

    def __repr__(self) -> str:
        return self._df.to_string(10)

    def __str__(self) -> str:
        return self._df.to_string(10)

    def show(self, n: int = 10) -> None:
        print(self._df.to_string(n))

    def preview(self, n: int = PREVIEW_ROWS) -> None:
        """Show the first ``n`` rows; see :func:`preview`."""
        preview(self, n)

    def head(self, n: int = 5) -> DataFrame:
        return DataFrame(self._df.slice(0, n))

    def slice(self, offset: int, length: int) -> DataFrame:
        return DataFrame(self._df.slice(offset, length))

    # ---- lazy passthrough ------------------------------------------------
    def lazy(self) -> LazyFrame:
        return LazyFrame(self._df.lazy(_ctx()))

    def filter(self, *predicates: Any) -> DataFrame:
        return self.lazy().filter(*predicates).collect()

    def select(self, *exprs: Any, **named: Any) -> DataFrame:
        return self.lazy().select(*exprs, **named).collect()

    def with_columns(self, *exprs: Any, **named: Any) -> DataFrame:
        return self.lazy().with_columns(*exprs, **named).collect()

    def sort(self, by: Any, *more_by: Any, **kwargs: Any) -> DataFrame:
        return self.lazy().sort(by, *more_by, **kwargs).collect()

    def join(self, other: LazyFrame | DataFrame, *args: Any, **kwargs: Any) -> DataFrame:
        return self.lazy().join(other, *args, **kwargs).collect()

    def group_by(self, *keys: Any) -> _EagerGroupBy:
        return _EagerGroupBy(self.lazy().group_by(*keys))

    def explode(self, columns: Any, *more: Any) -> DataFrame:
        return self.lazy().explode(columns, *more).collect()

    def unnest(self, columns: Any, *more: Any, separator: str | None = None) -> DataFrame:
        return self.lazy().unnest(columns, *more, separator=separator).collect()

    def unique(self) -> DataFrame:
        return self.lazy().unique().collect()

    def sql(self, query: str, table_name: str = "self", params: Any = None) -> DataFrame:
        return self.lazy().sql(query, table_name, params).collect()

    # ---- output ----------------------------------------------------------
    def write_delta(
        self,
        path: str,
        mode: str = "error",
        partition_by: str | Sequence[str] | None = None,
        storage_options: StorageOptions | None = None,
        schema_mode: str | None = None,
    ) -> None:
        """Write to a Delta table (a path or ``s3://`` URL); see
        ``LazyFrame.sink_delta`` for the modes and ``schema_mode``."""
        self.lazy().sink_delta(path, mode, partition_by, storage_options, schema_mode)

    # ---- output ----------------------------------------------------------
    def write_parquet(
        self,
        path: str,
        compression: str = "zstd",
        row_group_size: int | None = None,
        storage_options: StorageOptions | None = None,
    ) -> None:
        """Write to a local file or an object store URL (``s3://bucket/key.parquet``)."""
        self._df.write_parquet(str(path), compression, row_group_size, _storage(storage_options))

    def write_csv(
        self,
        path: str,
        separator: str = ",",
        include_header: bool = True,
        storage_options: StorageOptions | None = None,
    ) -> None:
        self._df.write_csv(str(path), include_header, separator, _storage(storage_options))

    def write_ndjson(self, path: str, storage_options: StorageOptions | None = None) -> None:
        """Write one JSON object per row (a local file or an object store URL)."""
        self._df.write_ndjson(str(path), _storage(storage_options))


class _EagerGroupBy:
    __slots__ = ("_g",)

    def __init__(self, g: GroupBy) -> None:
        self._g = g

    def agg(self, *aggs: Any, **named: Any) -> DataFrame:
        return self._g.agg(*aggs, **named).collect()


# ---------------------------------------------------------------------------
# I/O & entry points
# ---------------------------------------------------------------------------


def scan_parquet(path: str, storage_options: StorageOptions | None = None) -> LazyFrame:
    """Lazily scan a Parquet file, directory, glob pattern or URL
    (``s3://bucket/prefix/``, ``s3://bucket/**/*.parquet``)."""
    return LazyFrame(_ctx().read_parquet(str(path), _storage(storage_options)))


def _delta_millis(timestamp: Any) -> int | None:
    """A time travel timestamp as milliseconds since the epoch: an int (already
    milliseconds), a ``datetime`` (naive means UTC) or an ISO 8601 string."""
    if timestamp is None:
        return None
    if isinstance(timestamp, bool):
        raise TypeError("timestamp must be an int, a datetime or an ISO 8601 string")
    if isinstance(timestamp, int):
        return timestamp
    if isinstance(timestamp, str):
        timestamp = _datetime.datetime.fromisoformat(timestamp)
    if isinstance(timestamp, _datetime.datetime):
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=_datetime.timezone.utc)
        return round(timestamp.timestamp() * 1000)
    raise TypeError("timestamp must be an int, a datetime or an ISO 8601 string")


def scan_delta(
    path: str,
    version: int | None = None,
    timestamp: Any = None,
    storage_options: StorageOptions | None = None,
) -> LazyFrame:
    """Lazily scan a Delta table (a folder or ``s3://`` URL with a ``_delta_log``).
    ``version`` or ``timestamp`` (a ``datetime``, an ISO 8601 string or
    milliseconds since the epoch; the newest version committed at or before it)
    read an older state of the table. Partition columns come from the log, and
    filters skip files by partition value and by the log's statistics."""
    return LazyFrame(_ctx().read_delta(str(path), version, _delta_millis(timestamp), _storage(storage_options)))


def scan_csv(
    path: str,
    has_header: bool = True,
    separator: str = ",",
    infer_schema_length: int = 10000,
    parallel: bool = True,
    storage_options: StorageOptions | None = None,
    **options: Any,
) -> LazyFrame:
    """Lazily scan CSV files (a path, folder, glob or URL).

    Besides the arguments above, see ``iara.file_io`` for ``quote_char``,
    ``escape``, ``null_values``, ``skip_rows``, ``comment``, ``columns``,
    ``schema_overrides`` / ``dtypes``, ``encoding`` and ``try_parse_dates``."""
    return LazyFrame(
        _ctx().read_csv(
            str(path),
            has_header,
            separator,
            infer_schema_length,
            parallel,
            _storage(storage_options),
            _fio.csv_options(**options),
        )
    )


def scan_ndjson(
    path: str,
    infer_schema_length: int = 1000,
    parallel: bool = True,
    storage_options: StorageOptions | None = None,
    format: str = "ndjson",
    nested: str = "auto",
) -> LazyFrame:
    """Lazily scan newline-delimited JSON (a path, folder, glob or URL; ``.ndjson``,
    ``.jsonl`` and ``.json`` files). The schema comes from the first
    ``infer_schema_length`` records. Objects and arrays are read as struct and list
    columns (``nested="auto"``, merging the shapes seen: a field missing from some
    records is null there, and a conflict makes that field JSON text);
    ``nested="text"`` reads them as JSON text."""
    opts = _fio.json_options(infer_schema_length=infer_schema_length, parallel=parallel, format=format, nested=nested)
    return LazyFrame(_ctx().read_json(str(path), opts, _storage(storage_options)))


def scan_json(
    path: str,
    infer_schema_length: int = 1000,
    parallel: bool = True,
    storage_options: StorageOptions | None = None,
    format: str = "auto",
    nested: str = "auto",
) -> LazyFrame:
    """Like ``scan_ndjson``, but a file holding one JSON array of objects
    (``[{...}, {...}]``) is read too (``format="auto"`` looks at its first byte)."""
    return scan_ndjson(path, infer_schema_length, parallel, storage_options, format, nested)


def read_parquet(path: str, storage_options: StorageOptions | None = None) -> DataFrame:
    return scan_parquet(path, storage_options).collect()


def read_delta(
    path: str,
    version: int | None = None,
    timestamp: Any = None,
    storage_options: StorageOptions | None = None,
) -> DataFrame:
    return scan_delta(path, version, timestamp, storage_options).collect()


def read_csv(path: str, **kwargs: Any) -> DataFrame:
    return scan_csv(path, **kwargs).collect()


def read_ndjson(path: str, **kwargs: Any) -> DataFrame:
    return scan_ndjson(path, **kwargs).collect()


def read_json(path: str, **kwargs: Any) -> DataFrame:
    return scan_json(path, **kwargs).collect()


def from_arrow(data: Any) -> DataFrame:
    """From any object implementing the Arrow C stream protocol (pyarrow, polars, ...)."""
    return DataFrame(PyDataFrame.from_arrow(data))


def from_pandas(df: Any) -> DataFrame:
    import pyarrow as pa

    return from_arrow(pa.Table.from_pandas(df, preserve_index=False))


def from_polars(df: Any) -> DataFrame:
    return from_arrow(df.to_arrow())


def from_dict(data: Mapping[str, Sequence[Any]]) -> DataFrame:
    import pyarrow as pa

    return from_arrow(pa.table(dict(data)))


def _register(ctx: PySessionContext, name: str, obj: Any) -> None:
    if isinstance(obj, LazyFrame):
        ctx.register_lazy(name, obj._lf)
    elif isinstance(obj, DataFrame):
        ctx.register_dataframe(name, obj._df)
    elif isinstance(obj, str):
        if obj.lower().endswith(".csv"):
            ctx.register_csv(name, obj)
        elif _fio.is_json_path(obj):
            ctx.register_json(name, obj)
        else:
            ctx.register_parquet(name, obj)
    else:
        ctx.register_arrow(name, obj)


class SessionContext:
    """Session state: catalogs of named tables queried with SQL or the DataFrame API.

    Names are ``table``, ``schema.table`` or ``catalog.schema.table``. The names
    given to ``register_*`` and ``table()`` are relative to the default catalog
    (``default_catalog``, ``main`` when not given): ``t`` is ``default.main.t`` and
    ``s.t`` is ``default.s.t``; only a three-part name reaches another catalog."""

    def __init__(self, default_catalog: str | None = None) -> None:
        self._ctx = PySessionContext(default_catalog)

    def register(self, name: str, obj: Any) -> SessionContext:
        """Register a LazyFrame, DataFrame, pyarrow/polars/pandas table or a file path."""
        _register(self._ctx, name, obj)
        return self

    def register_parquet(
        self, name: str, path: str, storage_options: StorageOptions | None = None, lazy: bool = False
    ) -> SessionContext:
        """Register Parquet files (path, directory, glob or URL). With ``lazy``
        they are listed on first use, and a table that cannot be read fails
        only the queries that use it."""
        self._ctx.register_parquet(name, str(path), _storage(storage_options), lazy)
        return self

    def register_table(
        self, name: str, path: str, storage_options: StorageOptions | None = None, lazy: bool = False
    ) -> SessionContext:
        """Register a folder of Parquet files or a Delta table (whichever the
        folder holds, detected when the table loads)."""
        self._ctx.register_table(name, str(path), _storage(storage_options), lazy)
        return self

    def register_delta(
        self, name: str, path: str, storage_options: StorageOptions | None = None, lazy: bool = False
    ) -> SessionContext:
        """Register a Delta table (its newest version at load time)."""
        self._ctx.register_delta(name, str(path), _storage(storage_options), lazy)
        return self

    def register_csv(
        self,
        name: str,
        path: str,
        has_header: bool = True,
        separator: str = ",",
        storage_options: StorageOptions | None = None,
        lazy: bool = False,
        **options: Any,
    ) -> SessionContext:
        """Register CSV files; ``options`` are those of ``scan_csv``."""
        opts = _fio.csv_options(**options)
        self._ctx.register_csv(name, str(path), has_header, separator, 10000, True, _storage(storage_options), lazy, opts)
        return self

    def register_json(
        self,
        name: str,
        path: str,
        storage_options: StorageOptions | None = None,
        lazy: bool = False,
        infer_schema_length: int = 1000,
        format: str = "auto",
        nested: str = "auto",
    ) -> SessionContext:
        """Register JSON / NDJSON files (a path, folder, glob or URL)."""
        opts = _fio.json_options(infer_schema_length=infer_schema_length, format=format, nested=nested)
        self._ctx.register_json(name, str(path), opts, _storage(storage_options), lazy)
        return self

    def is_loaded(self, name: str) -> bool | None:
        """False while a lazily registered table was not used yet."""
        return self._ctx.is_loaded(name)

    def column_stats(self, name: str) -> list[tuple[str, str | None, str | None, int, bool]]:
        """``(column, min, max, nulls, exact)`` per column, from Parquet metadata."""
        return self._ctx.column_stats(name)

    def deregister(self, name: str) -> bool:
        return self._ctx.deregister(name)

    def fork(self) -> SessionContext:
        """A new session starting with this one's tables (registrations on
        either side afterwards are independent)."""
        child = SessionContext.__new__(SessionContext)
        child._ctx = self._ctx.fork()
        return child

    def restricted(self, allow: list[str]) -> SessionContext:
        """A new session limited to reading the tables ``allow`` covers (``*``,
        catalog, catalog.schema, catalog.schema.table); files and writes are refused."""
        child = SessionContext.__new__(SessionContext)
        child._ctx = self._ctx.restricted([str(a).lower() for a in allow])
        return child

    def tables_read(self) -> list[str]:
        """The tables and views a restricted session has read so far, as sorted
        ``catalog.schema.table`` names; empty for a session that is not restricted."""
        return self._ctx.tables_read()

    def set_warehouse(self, path: str | os.PathLike[str] | None, storage_options: StorageOptions | None = None) -> SessionContext:
        """Where ``CREATE TABLE name AS ...`` writes the table: Delta in
        ``<path>/name/`` (a folder or ``s3://`` prefix), ``<path>/schema/name/``
        for a table in a schema other than ``main``, or
        ``<path>/_catalogs/catalog/schema/name/`` for a table of another catalog.
        Without a warehouse, created tables stay in memory."""
        self._ctx.set_warehouse(None if path is None else str(path), _storage(storage_options))
        return self

    @property
    def warehouse(self) -> str | None:
        return self._ctx.warehouse()

    def set_schema_location(
        self, schema: str, path: str | os.PathLike[str] | None, storage_options: StorageOptions | None = None
    ) -> SessionContext:
        """Where ``CREATE TABLE schema.name AS ...`` writes the table: in
        ``<path>/name/`` (a folder or ``s3://`` prefix), instead of the warehouse.
        ``schema`` is ``s`` (of the default catalog) or ``catalog.s``."""
        self._ctx.set_schema_location(schema, None if path is None else str(path), _storage(storage_options))
        return self

    def schema_location(self, schema: str) -> str | None:
        return self._ctx.schema_location(schema)

    def tables(self) -> list[str]:
        """Table names: in the default catalog bare for ``main`` and ``schema.table``
        for the others; in any other catalog always ``catalog.schema.table``."""
        return self._ctx.tables()

    def catalogs(self) -> list[str]:
        """Catalog names, the default one first and the others sorted. ``CREATE
        CATALOG`` adds one."""
        return self._ctx.catalogs()

    def current_catalog(self) -> str:
        """The catalog that two-part names and ``SHOW SCHEMAS`` refer to;
        ``USE CATALOG`` sets it (the default catalog at first)."""
        return self._ctx.current_catalog()

    def default_catalog(self) -> str:
        """The catalog that ``register_*`` and ``table()`` names are relative to."""
        return self._ctx.default_catalog()

    def schemas(self, catalog: str | None = None) -> list[str]:
        """Schema names of ``catalog`` (the current catalog when None), ``main``
        first and the others sorted. ``CREATE SCHEMA`` adds one, and so does
        registering ``schema.table``."""
        return self._ctx.schemas(catalog)

    def current_schema(self) -> str:
        """The schema of the current catalog a bare table name is looked up in
        first (then ``main``); ``USE schema`` sets it."""
        return self._ctx.current_schema()

    def table(self, name: str) -> LazyFrame:
        """A registered table by its ``register_*`` name: ``t``, ``schema.t`` or
        ``catalog.schema.t``, always relative to the default catalog (``USE
        CATALOG`` does not change it)."""
        return LazyFrame(self._ctx.table(name))

    def sql(self, query: str, params: Any = None) -> LazyFrame:
        """Run SQL. ``params`` binds the query's placeholders: a list or tuple
        for ``$1``, ``$2`` / ``?``, a dict for ``:name`` / ``$name``."""
        return LazyFrame(self._ctx.sql(query, params))

    def read_parquet(self, path: str, storage_options: StorageOptions | None = None) -> LazyFrame:
        return LazyFrame(self._ctx.read_parquet(str(path), _storage(storage_options)))

    def read_delta(
        self,
        path: str,
        version: int | None = None,
        timestamp: Any = None,
        storage_options: StorageOptions | None = None,
    ) -> LazyFrame:
        return LazyFrame(self._ctx.read_delta(str(path), version, _delta_millis(timestamp), _storage(storage_options)))

    def read_csv(
        self,
        path: str,
        has_header: bool = True,
        separator: str = ",",
        storage_options: StorageOptions | None = None,
        **options: Any,
    ) -> LazyFrame:
        opts = _fio.csv_options(**options)
        return LazyFrame(self._ctx.read_csv(str(path), has_header, separator, 10000, True, _storage(storage_options), opts))

    def read_json(
        self,
        path: str,
        storage_options: StorageOptions | None = None,
        infer_schema_length: int = 1000,
        format: str = "auto",
        nested: str = "auto",
    ) -> LazyFrame:
        opts = _fio.json_options(infer_schema_length=infer_schema_length, format=format, nested=nested)
        return LazyFrame(self._ctx.read_json(str(path), opts, _storage(storage_options)))

    def from_arrow(self, data: Any) -> LazyFrame:
        return LazyFrame(self._ctx.from_arrow(data))


def workspace(path: str | None = None) -> Any:
    """The workspace (``iara.toml`` catalog) at ``path`` or found from the
    current directory upward; see :mod:`iara.workspaces`."""
    from iara.workspaces import load

    return load(path)


def sql(query: str, params: Any = None, **tables: Any) -> LazyFrame:
    """Run SQL; keyword arguments are registered as tables (``params`` is
    reserved). ``params`` binds the query's placeholders: a list or tuple for
    ``$1``, ``$2`` / ``?``, a dict for ``:name`` / ``$name``. Values may be
    int, float, str, bool, None, bytes, date, datetime and Decimal.

    >>> iara.sql("SELECT a, sum(b) FROM t WHERE a > $1 GROUP BY a", [10], t=my_frame).collect()
    >>> iara.sql("SELECT * FROM t WHERE d >= :since", {"since": date(2024, 1, 1)}, t=my_frame).collect()
    """
    ctx = PySessionContext()
    for name, obj in tables.items():
        _register(ctx, name, obj)
    return LazyFrame(ctx.sql(query, params))


#: where ``preview`` sends a frame: set by the Studio's kernel while a cell runs
_preview_sink: _contextvars.ContextVar[Any] = _contextvars.ContextVar("iara_preview", default=None)


def preview(frame: Any, n: int = PREVIEW_ROWS) -> None:
    """Show the first ``n`` rows of a frame (a LazyFrame runs with a limit).

    In a Studio notebook they become the cell's table output, which pages,
    sorts, charts and downloads (the download has all the rows); several
    calls in a cell show one tab per frame. Elsewhere
    they are printed. A frame a cell ends with is not shown on its own:
    ``collect()`` only collects.
    """
    sink = _preview_sink.get()
    if sink is not None:
        sink(frame, n)
        return
    if isinstance(frame, LazyFrame):
        frame = frame.limit(n).collect()
    elif not isinstance(frame, DataFrame):
        frame = from_arrow(frame)
    frame.show(n)


# expression functions (`from iara import functions as F`)
from iara import functions  # noqa: E402

# P1 frame ops (fill/drop nulls and NaN, unique, sample, row index, describe, union by name)
from iara import frame_ops as _frame_ops  # noqa: E402

_frame_ops.attach(LazyFrame, DataFrame)
concat = _frame_ops.concat
