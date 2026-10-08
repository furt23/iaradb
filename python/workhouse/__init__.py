"""Workhouse Engine - a parallel, vectorized query engine written in Rust.

Lazy DataFrame API (Polars-like) and SQL (Spark/DuckDB-like) on top of the
same optimizer and morsel-driven parallel executor. Data is exchanged with
pyarrow / pandas / polars zero-copy through the Arrow C stream interface.

    >>> import workhouse as wh
    >>> (wh.scan_parquet("lineitem/*.parquet")
    ...    .filter(wh.col("l_shipdate") <= datetime.date(1998, 9, 2))
    ...    .group_by("l_returnflag", "l_linestatus")
    ...    .agg(wh.col("l_quantity").sum().alias("sum_qty"))
    ...    .sort("l_returnflag")
    ...    .collect())
"""

from __future__ import annotations

from typing import Any, Iterable, Iterator, Mapping, Sequence

from workhouse._workhouse import (
    PyDataFrame,
    PyExpr,
    PyLazyFrame,
    PySessionContext,
    QueryCancelled,
    WorkhouseError,
    __version__,
    cancel_query,
    interrupt,
    memory_usage,
    num_threads,
    running_queries,
    set_memory_limit,
    set_num_threads,
)
from workhouse import _window
from workhouse._window import WindowMethods
from workhouse.storage import StorageError, StorageOptions, list_files, set_storage_options
from workhouse.storage import normalize as _storage

__all__ = [
    "Expr",
    "LazyFrame",
    "ResultStream",
    "DataFrame",
    "SessionContext",
    "WorkhouseError",
    "QueryCancelled",
    "StorageError",
    "set_storage_options",
    "list_files",
    "interrupt",
    "cancel_query",
    "running_queries",
    "col",
    "lit",
    "when",
    "count",
    "len",
    "sum",
    "mean",
    "min",
    "max",
    "coalesce",
    "concat_str",
    "greatest",
    "least",
    "all",
    "row_number",
    "scan_parquet",
    "scan_csv",
    "read_parquet",
    "read_csv",
    "from_arrow",
    "from_pandas",
    "from_polars",
    "from_dict",
    "sql",
    "workspace",
    "set_num_threads",
    "num_threads",
    "set_memory_limit",
    "memory_usage",
    "__version__",
]

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
    return Expr(PyExpr.lit(x))


def _col_or_expr(x: Any) -> Expr:
    """Strings are column names (used by select / group_by / sort ...)."""
    if isinstance(x, Expr):
        return x
    if isinstance(x, str):
        return col(x)
    return _expr(x)


def _flatten(items: Iterable[Any]) -> list[Any]:
    out: list[Any] = []
    for i in items:
        if isinstance(i, (list, tuple)):
            out.extend(_flatten(i))
        else:
            out.append(i)
    return out


def _named(e: Expr) -> PyExpr:
    """Polars-style naming: unaliased expressions take their root column name."""
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
        return self._bin("%", o)

    def __rmod__(self, o: Any) -> Expr:
        return self._bin("%", o, True)

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

    @property
    def str(self) -> _StrNamespace:
        return _StrNamespace(self)

    @property
    def dt(self) -> _DtNamespace:
        return _DtNamespace(self)


class _Filtered(Expr):
    """`col(x).filter(pred)`: only meaningful when followed by an aggregation."""

    __slots__ = ("_base", "_pred")

    def __init__(self, base: Expr, pred: Expr) -> None:
        super().__init__(base._e)
        self._base = base
        self._pred = pred

    def _agg(self, name: str, distinct: bool = False) -> Expr:
        return Expr(self._base._e.agg(name, distinct).agg_filter(self._pred._e))

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


class _StrNamespace:
    __slots__ = ("_x",)

    def __init__(self, x: Expr) -> None:
        self._x = x

    def contains(self, pattern: str, literal: bool = True) -> Expr:
        if literal:
            return self._x._f("contains", pattern)
        raise NotImplementedError("regex contains is not supported yet; use literal=True or .str.like()")

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

    def replace_all(self, old: str, new: str) -> Expr:
        return self._x._f("replace", old, new)

    replace = replace_all

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


def col(name: str, *more: str) -> Any:
    """Reference a column (several names -> list of expressions; "*" -> all)."""
    if more:
        return [col(n) for n in (name, *more)]
    if name == "*":
        return Expr(PyExpr.wildcard())
    return Expr(PyExpr.col(name))


def all() -> Expr:  # noqa: A001
    return Expr(PyExpr.wildcard())


def lit(value: Any) -> Expr:
    return Expr(PyExpr.lit(value))


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

    def select(self, *exprs: Any, **named: Any) -> LazyFrame:
        return LazyFrame(self._lf.select(_exprs(exprs, named)))

    def with_columns(self, *exprs: Any, **named: Any) -> LazyFrame:
        return LazyFrame(self._lf.with_columns(_exprs(exprs, named)))

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

    def rename(self, mapping: Mapping[str, str]) -> LazyFrame:
        return LazyFrame(self._lf.rename(list(mapping.items())))

    def union(self, *others: LazyFrame | DataFrame) -> LazyFrame:
        lfs = [(o.lazy() if isinstance(o, DataFrame) else o)._lf for o in _flatten(others)]
        return LazyFrame(self._lf.union(lfs))

    def sql(self, query: str, table_name: str = "self") -> LazyFrame:
        """Run SQL against this frame (referenced as `self` by default)."""
        ctx = PySessionContext()
        ctx.register_lazy(table_name, self._lf)
        return LazyFrame(ctx.sql(query))

    # ---- execution -------------------------------------------------------
    def explain(self, optimized: bool = True) -> str:
        return self._lf.explain(optimized)

    def explain_tree(self) -> dict[str, Any]:
        """The physical plan as nested dicts: `{name, detail, role, children}`."""
        return self._lf.plan_tree()

    def collect(self) -> DataFrame:
        return DataFrame(self._lf.collect())

    def profile(self) -> tuple[DataFrame, dict[str, Any]]:
        """Collect, also returning the run profile: `{id, elapsed_ms, cancelled,
        memory_peak, spilled_bytes, pipelines: [{source, operators, sink,
        morsels_total, morsels_done, rows_in, rows_out, elapsed_ms, finished}]}`."""
        df, prof = self._lf.collect_profiled()
        return DataFrame(df), prof

    def fetch(self, n: int = 5) -> DataFrame:
        return self.limit(n).collect()

    def sink_parquet(
        self,
        path: str,
        compression: str = "zstd",
        row_group_size: int | None = None,
        storage_options: StorageOptions | None = None,
    ) -> int:
        """Write the result to Parquet (a path or ``s3://`` URL) while it is
        produced, without collecting it; returns the number of rows."""
        return self._lf.sink_parquet(str(path), compression, row_group_size, _storage(storage_options))

    def sink_csv(
        self, path: str, separator: str = ",", include_header: bool = True, storage_options: StorageOptions | None = None
    ) -> int:
        """Write the result to CSV while it is produced; returns the number of rows."""
        return self._lf.sink_csv(str(path), include_header, separator, _storage(storage_options))

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
        return self.agg(*[getattr(col(c), method)() for c in cols])

    def sum(self) -> LazyFrame:
        return self._all("sum")

    def mean(self) -> LazyFrame:
        return self._all("mean")

    def min(self) -> LazyFrame:
        return self._all("min")

    def max(self) -> LazyFrame:
        return self._all("max")

    def count(self) -> LazyFrame:
        return self.agg(count())

    def len(self) -> LazyFrame:
        return self.agg(len())


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
        return self.to_arrow().to_pandas(**kwargs)

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

    def unique(self) -> DataFrame:
        return self.lazy().unique().collect()

    def sql(self, query: str, table_name: str = "self") -> DataFrame:
        return self.lazy().sql(query, table_name).collect()

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


def scan_csv(
    path: str,
    has_header: bool = True,
    separator: str = ",",
    infer_schema_length: int = 10000,
    parallel: bool = True,
    storage_options: StorageOptions | None = None,
) -> LazyFrame:
    return LazyFrame(
        _ctx().read_csv(str(path), has_header, separator, infer_schema_length, parallel, _storage(storage_options))
    )


def read_parquet(path: str, storage_options: StorageOptions | None = None) -> DataFrame:
    return scan_parquet(path, storage_options).collect()


def read_csv(path: str, **kwargs: Any) -> DataFrame:
    return scan_csv(path, **kwargs).collect()


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
        else:
            ctx.register_parquet(name, obj)
    else:
        ctx.register_arrow(name, obj)


class SessionContext:
    """Spark-style session: a catalog of named tables queried with SQL or the DataFrame API."""

    def __init__(self) -> None:
        self._ctx = PySessionContext()

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

    def register_csv(
        self,
        name: str,
        path: str,
        has_header: bool = True,
        separator: str = ",",
        storage_options: StorageOptions | None = None,
        lazy: bool = False,
    ) -> SessionContext:
        self._ctx.register_csv(name, str(path), has_header, separator, 10000, True, _storage(storage_options), lazy)
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

    def tables(self) -> list[str]:
        return self._ctx.tables()

    def table(self, name: str) -> LazyFrame:
        return LazyFrame(self._ctx.table(name))

    def sql(self, query: str) -> LazyFrame:
        return LazyFrame(self._ctx.sql(query))

    def read_parquet(self, path: str, storage_options: StorageOptions | None = None) -> LazyFrame:
        return LazyFrame(self._ctx.read_parquet(str(path), _storage(storage_options)))

    def read_csv(
        self, path: str, has_header: bool = True, separator: str = ",", storage_options: StorageOptions | None = None
    ) -> LazyFrame:
        return LazyFrame(self._ctx.read_csv(str(path), has_header, separator, 10000, True, _storage(storage_options)))

    def from_arrow(self, data: Any) -> LazyFrame:
        return LazyFrame(self._ctx.from_arrow(data))


def workspace(path: str | None = None) -> Any:
    """The workspace (``workhouse.toml`` catalog) at ``path`` or found from the
    current directory upward; see :mod:`workhouse.workspaces`."""
    from workhouse.workspaces import load

    return load(path)


def sql(query: str, **tables: Any) -> LazyFrame:
    """Run SQL; keyword arguments are registered as tables.

    >>> wh.sql("SELECT a, sum(b) FROM t GROUP BY a", t=my_frame).collect()
    """
    ctx = PySessionContext()
    for name, obj in tables.items():
        _register(ctx, name, obj)
    return LazyFrame(ctx.sql(query))
