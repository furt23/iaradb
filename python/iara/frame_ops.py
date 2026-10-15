"""P1 frame operations: null and NaN filling and dropping, unique, sample,
row index, describe, and union by name.

Each one is a plan built from the expression API and window functions, so
the engine runs it like any other query. Semantics:

- NaN follows the engine's total order (NaN equals NaN and sorts above
  +inf), so "is NaN" is `x == nan`. A null is never NaN.
- The Python API follows Polars; the SQL equivalents follow DuckDB.
- `sample` ranks `rand(seed, row index)`: deterministic for a seed, under
  any execution order.
"""

from __future__ import annotations

import math
import random
from typing import Any, Sequence

import pyarrow as pa

import iara as ia
from iara import functions as F

_IDX = "__row_index"
_RN = "__rank"
_CNT = "__group_size"
_KEY = "__hash"
_POS = "__pos"
_DRAW = "__draw"
_KEEP = ("any", "first", "last", "none")
_FLOATS = ("Float32", "Float64")
_NUMERIC_PREFIXES = ("Int", "UInt", "Float", "Decimal")
_P = 2147483647  # seeds are reduced to this range
_QUANTILES = (0.25, 0.5, 0.75)
_STATS = ("count", "null_count", "mean", "std", "min", "25%", "50%", "75%", "max")


# ---- helpers --------------------------------------------------------------
def _names(lf: ia.LazyFrame, subset: Any) -> list[str]:
    if subset is None:
        return list(lf.columns)
    names = [subset] if isinstance(subset, str) else list(subset)
    missing = [n for n in names if n not in lf.columns]
    if missing:
        raise ValueError(f"unknown columns: {missing}")
    return names


def _float_names(lf: ia.LazyFrame, subset: Any) -> list[str]:
    schema = lf.schema
    if subset is None:
        return [n for n, dt in schema.items() if dt in _FLOATS]
    names = _names(lf, subset)
    bad = [n for n in names if schema[n] not in _FLOATS]
    if bad:
        raise TypeError(f"NaN handling needs float columns, got: {bad}")
    return names


def _is_numeric(dtype: str) -> bool:
    return dtype.startswith(_NUMERIC_PREFIXES)


def _lazy(x: Any) -> ia.LazyFrame:
    return x.lazy() if isinstance(x, ia.DataFrame) else x


def _height(lf: ia.LazyFrame) -> int:
    return int(lf.agg(F.len().alias("n")).collect().item())


def _nan() -> ia.Expr:
    return F.lit(math.nan)


# ---- nulls and NaN --------------------------------------------------------
def fill_null(
    self: ia.LazyFrame,
    value: Any = None,
    strategy: str | None = None,
    subset: Any = None,
) -> ia.LazyFrame:
    """Replace nulls with `value`, or with a strategy: "forward", "backward",
    "min", "max", "mean", "zero", "one"."""
    if (value is None) == (strategy is None):
        raise ValueError("pass exactly one of `value` or `strategy`")
    names = _names(self, subset)
    if strategy in ("forward", "backward"):
        return _fill_directional(self, names, strategy)
    return self.with_columns([_fill_expr(n, value, strategy) for n in names])


def _fill_expr(name: str, value: Any, strategy: str | None) -> ia.Expr:
    c = F.col(name)
    if strategy is None:
        fill = F.lit(value)
    elif strategy == "zero":
        fill = F.lit(0)
    elif strategy == "one":
        fill = F.lit(1)
    elif strategy in ("min", "max", "mean"):
        fill = getattr(c, strategy)().over()
    else:
        raise ValueError(f"unknown fill strategy: {strategy!r}")
    return F.coalesce(c, fill).alias(name)


def _fill_directional(lf: ia.LazyFrame, names: list[str], strategy: str) -> ia.LazyFrame:
    """Forward fill takes the last non-null up to the row; backward takes the
    first non-null from the row on. `last()`/`first()` over a frame skip nulls."""
    if strategy == "forward":
        frame, pick = ("rows", None, 0), "last"
    else:
        frame, pick = ("rows", 0, None), "first"
    order = F.col(_IDX)
    exprs = [
        getattr(F.col(n), pick)().over(order_by=order, frame=frame).alias(n)
        for n in names
    ]
    return lf.with_row_index(_IDX).with_columns(exprs).drop(_IDX)


def fill_nan(self: ia.LazyFrame, value: Any, subset: Any = None) -> ia.LazyFrame:
    """Replace NaN with `value` in float columns (all of them by default)."""
    exprs = []
    for n in _float_names(self, subset):
        c = F.col(n)
        exprs.append(F.when(c == _nan()).then(F.lit(value)).otherwise(c).alias(n))
    return self.with_columns(exprs) if exprs else self


def drop_nulls(self: ia.LazyFrame, subset: Any = None) -> ia.LazyFrame:
    """Keep rows where every column in `subset` (default all) is not null."""
    names = _names(self, subset)
    if not names:
        return self
    return self.filter(*[F.col(n).is_not_null() for n in names])


def drop_nans(self: ia.LazyFrame, subset: Any = None) -> ia.LazyFrame:
    """Drop rows with NaN in any float column of `subset`; nulls are kept."""
    names = _float_names(self, subset)
    if not names:
        return self
    keep = [F.col(n).is_null() | (F.col(n) != _nan()) for n in names]
    return self.filter(*keep)


# ---- unique ---------------------------------------------------------------
def unique(
    self: ia.LazyFrame,
    subset: Any = None,
    keep: str = "any",
    maintain_order: bool = False,
) -> ia.LazyFrame:
    """Drop duplicate rows, comparing `subset` (default all columns).

    keep: "any" and "first" keep the first row of each group (so "any" is
    deterministic here), "last" keeps the last, "none" keeps only the groups
    that had one row. Nulls compare equal, as in SQL DISTINCT. Row order is
    kept when `maintain_order` is set, otherwise it is not guaranteed."""
    if keep not in _KEEP:
        raise ValueError(f"keep must be one of {_KEEP}, got {keep!r}")
    names = _names(self, subset)
    if keep == "any" and subset is None:
        return ia.LazyFrame(self._lf.distinct())
    ranked = self.with_row_index(_IDX).with_columns(
        F.row_number().over(names, order_by=F.col(_IDX)).alias(_RN),
        F.count().over(names).alias(_CNT),
    )
    if keep == "last":
        pred = F.col(_RN) == F.col(_CNT)
    elif keep == "none":
        pred = F.col(_CNT) == 1
    else:
        pred = F.col(_RN) == 1
    out = ranked.filter(pred)
    if maintain_order:
        out = out.sort(_IDX)
    return out.drop(_IDX, _RN, _CNT)


# ---- sample ---------------------------------------------------------------
def sample(
    self: ia.LazyFrame,
    n: int | None = None,
    fraction: float | None = None,
    seed: int | None = None,
    with_replacement: bool = False,
) -> ia.LazyFrame:
    """Random rows: exactly `n` (or round(fraction * rows)). The same seed
    gives the same rows, in their original order."""
    if (n is None) == (fraction is None):
        raise ValueError("pass exactly one of `n` or `fraction`")
    total = _height(self)
    if n is None:
        if fraction < 0:
            raise ValueError("fraction must be >= 0")
        n = int(round(total * fraction))
    if n < 0:
        raise ValueError("n must be >= 0")
    if not with_replacement and n > total:
        raise ValueError(f"cannot take {n} rows without replacement from {total}")
    seed = random.randrange(_P) if seed is None else seed
    if with_replacement:
        return _sample_with_replacement(self, n, seed, total)
    return _sample_without(self, n, seed)


def _uniform(x: ia.Expr, seed: int) -> ia.Expr:
    """A float in [0, 1) that depends only on (seed, x)."""
    return F.rand(seed % _P, x)


def _sample_without(lf: ia.LazyFrame, n: int, seed: int) -> ia.LazyFrame:
    idx = F.col(_IDX)
    keyed = lf.with_row_index(_IDX).with_columns(_uniform(idx, seed).alias(_KEY))
    ranked = keyed.with_columns(
        F.row_number().over(order_by=[F.col(_KEY), idx]).alias(_RN)
    )
    return ranked.filter(F.col(_RN) <= n).sort(_IDX).drop(_IDX, _KEY, _RN)


def _sample_with_replacement(lf: ia.LazyFrame, n: int, seed: int, total: int) -> ia.LazyFrame:
    if n and total == 0:
        raise ValueError("cannot sample rows from an empty frame")
    draws = ia.from_arrow(
        pa.table({_DRAW: pa.array(range(n), type=pa.int64())})
    ).lazy()
    draws = draws.with_columns((_uniform(F.col(_DRAW), seed) * total).floor().cast("Int64").alias(_POS))
    joined = lf.with_row_index(_IDX).join(draws, left_on=_IDX, right_on=_POS, how="inner")
    return joined.sort(_DRAW).drop(_IDX, _POS, _DRAW)


# ---- row index ------------------------------------------------------------
def with_row_index(self: ia.LazyFrame, name: str = "index", offset: int = 0) -> ia.LazyFrame:
    """Add a 0-based (plus `offset`) Int64 row number as the first column."""
    if name in self.columns:
        raise ValueError(f"column {name!r} already exists")
    index = F.row_number().over() + (offset - 1)
    return self.select(index.alias(name), *[F.col(c) for c in self.columns])


# ---- union by name / concat -----------------------------------------------
def _supertype(a: str, b: str) -> str:
    if a == b:
        return a
    if a == "Null":
        return b
    if b == "Null":
        return a
    if _is_numeric(a) and _is_numeric(b):
        floats = a.startswith(("Float", "Decimal")) or b.startswith(("Float", "Decimal"))
        return "Float64" if floats else "Int64"
    return "Utf8"


def _unify(schemas: Sequence[dict[str, str]]) -> tuple[list[str], dict[str, str]]:
    """Column names in first-seen order, each with a common type. Mixed
    non-numeric types become Utf8, as DuckDB's UNION ALL BY NAME does."""
    types: dict[str, str] = {}
    for schema in schemas:
        for name, dtype in schema.items():
            types[name] = _supertype(types[name], dtype) if name in types else dtype
    return list(types), types


def _align(frames: Sequence[ia.LazyFrame], names: list[str], types: dict[str, str]) -> list[ia.LazyFrame]:
    out = []
    for f in frames:
        schema = f.schema
        exprs = []
        for name in names:
            dt = types[name]
            if name not in schema:
                e = F.lit(None).cast(dt)
            elif schema[name] != dt:
                e = F.col(name).cast(dt)
            else:
                e = F.col(name)
            exprs.append(e.alias(name))
        out.append(f.select(exprs))
    return out


def concat(frames: Sequence[Any], how: str = "vertical") -> Any:
    """Stack frames. how="vertical" needs identical columns. how="diagonal"
    matches columns by name, fills missing ones with nulls and unifies types.
    Returns a LazyFrame, or a DataFrame when the first input is one."""
    if not frames:
        raise ValueError("concat needs at least one frame")
    lazies = [_lazy(f) for f in frames]
    if how == "vertical":
        cols = lazies[0].columns
        if any(f.columns != cols for f in lazies[1:]):
            raise ValueError("vertical concat needs the same columns; use how='diagonal'")
        result = lazies[0]
        if len(lazies) > 1:
            result = result.union(*lazies[1:])
    elif how == "diagonal":
        names, types = _unify([f.schema for f in lazies])
        aligned = _align(lazies, names, types)
        result = aligned[0].union(*aligned[1:]) if len(aligned) > 1 else aligned[0]
    else:
        raise ValueError(f"how must be 'vertical' or 'diagonal', got {how!r}")
    return result if isinstance(frames[0], ia.LazyFrame) else result.collect()


def union_by_name(self: ia.LazyFrame, *others: Any) -> ia.LazyFrame:
    """Stack frames matching columns by name (see `concat(how="diagonal")`)."""
    return concat([self, *others], how="diagonal")


# ---- describe -------------------------------------------------------------
def describe(self: ia.DataFrame) -> ia.DataFrame:
    """Summary statistics as strings, one row per statistic (as Polars does):
    count, null_count, mean, std, min, 25%, 50%, 75%, max. Mean, std and the
    quartiles are only filled for numeric columns; the quartiles interpolate
    linearly. Every column is summarized in one pass over the data."""
    lf = self.lazy()
    schema = lf.schema
    aggs = [F.len().alias("__rows")]
    for i, (name, dtype) in enumerate(schema.items()):
        aggs += _column_aggs(i, name, _is_numeric(dtype))
    row = lf.agg(*aggs).collect().to_dicts()[0]
    data: dict[str, list[str | None]] = {"statistic": list(_STATS)}
    for i, name in enumerate(schema):
        data[name] = _column_summary(row, i, row["__rows"])
    return ia.from_arrow(
        pa.table({k: pa.array(v, type=pa.string()) for k, v in data.items()})
    )


def _column_aggs(i: int, name: str, numeric: bool) -> list[ia.Expr]:
    """The aggregates of one column, named by its position (names may clash)."""
    c = F.col(name)
    aggs = [c.count().alias(f"{i}:count"), c.min().alias(f"{i}:min"), c.max().alias(f"{i}:max")]
    if numeric:
        aggs += [c.mean().alias(f"{i}:mean"), c.std().alias(f"{i}:std")]
        aggs += [c.quantile(q).alias(f"{i}:q{q}") for q in _QUANTILES]
    return aggs


def _column_summary(row: dict[str, Any], i: int, total: int) -> list[str | None]:
    count = row[f"{i}:count"]
    values: dict[str, Any] = {
        "count": count,
        "null_count": total - count,
        "mean": row.get(f"{i}:mean"),
        "std": row.get(f"{i}:std"),
        "min": row[f"{i}:min"],
        "max": row[f"{i}:max"],
    }
    values.update({label: row.get(f"{i}:q{q}") for label, q in zip(("25%", "50%", "75%"), _QUANTILES)})
    return [_text(values[s]) for s in _STATS]


def _text(x: Any) -> str | None:
    return None if x is None else str(x)


# ---- attachment -----------------------------------------------------------
_LAZY_METHODS = {
    "fill_null": fill_null,
    "fill_nan": fill_nan,
    "drop_nulls": drop_nulls,
    "drop_nans": drop_nans,
    "unique": unique,
    "drop_duplicates": unique,
    "sample": sample,
    "with_row_index": with_row_index,
    "union_by_name": union_by_name,
}


def _eager(name: str) -> Any:
    def method(self: ia.DataFrame, *args: Any, **kwargs: Any) -> ia.DataFrame:
        return getattr(self.lazy(), name)(*args, **kwargs).collect()

    method.__name__ = name
    method.__doc__ = _LAZY_METHODS[name].__doc__
    return method


def attach(lazy_cls: type, eager_cls: type) -> None:
    """Add these methods to LazyFrame, and their eager versions to DataFrame."""
    for name, fn in _LAZY_METHODS.items():
        setattr(lazy_cls, name, fn)
        setattr(eager_cls, name, _eager(name))
    eager_cls.describe = describe
    eager_cls.summary = describe
