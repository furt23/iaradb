"""Chart data from a stored result: aggregated or sampled in the kernel, so
the browser only receives the points it draws.

A spec is ``{kind, x, y, agg, group, bins}``:

- ``kind``: ``bar`` | ``line`` | ``area`` | ``scatter`` | ``histogram``;
- ``x``: the category / axis column (the measured column of a histogram);
- ``y``: the value columns (none for ``agg = "count"`` and histograms);
- ``agg``: ``sum`` | ``avg`` | ``count`` | ``min`` | ``max`` | ``none``;
- ``group``: an optional column that splits the values into series;
- ``bins``: histogram buckets.

The answer is ``{columns, rows, truncated}`` with JSON-safe values.
"""

from __future__ import annotations

from typing import Any

import pyarrow as pa
import pyarrow.compute as pc

from workhouse.kernel.runtime.results import json_value

#: points of an unaggregated chart
MAX_POINTS = 5000
#: categories of a bar chart / x values of a line or area chart
MAX_BARS = 100
MAX_LINE = 5000
MAX_BINS = 200

_AGG = {"sum": "sum", "avg": "mean", "min": "min", "max": "max", "count": "count"}


def _column(table: pa.Table, name: str | None) -> str:
    if not name or name not in table.column_names:
        raise ValueError(f"unknown column {name!r}")
    return name


def _answer(table: pa.Table, truncated: bool) -> dict[str, Any]:
    names = table.column_names
    rows = [[json_value(r[n]) for n in names] for r in table.to_pylist()]
    return {"columns": names, "rows": rows, "truncated": truncated}


def _numeric(t: pa.DataType) -> bool:
    return pa.types.is_integer(t) or pa.types.is_floating(t) or pa.types.is_decimal(t)


def _histogram(table: pa.Table, x: str, group: str | None, bins: int) -> dict[str, Any]:
    keep = [x] + ([group] if group else [])
    t = table.select(keep).filter(pc.is_valid(table[x]))
    if not _numeric(t.schema.field(x).type):
        raise ValueError(f"a histogram needs a numeric column; {x} is {t.schema.field(x).type}")
    values = pc.cast(t[x], pa.float64())
    if len(values) == 0:
        return {"columns": ["bin_start", "bin_end", *([group] if group else []), "count"], "rows": [], "truncated": False}
    bounds = pc.min_max(values).as_py()
    lo, hi = bounds["min"], bounds["max"]
    width = (hi - lo) / bins if hi > lo else 1.0
    index = pc.min_element_wise(pc.cast(pc.floor(pc.divide(pc.subtract(values, lo), width)), pa.int64()), bins - 1)
    binned = pa.table({"bin": index, **({group: t[group]} if group else {})})
    keys = ["bin"] + ([group] if group else [])
    counts = binned.group_by(keys).aggregate([([], "count_all")]).sort_by([(k, "ascending") for k in keys])
    starts = pc.add(pc.multiply(pc.cast(counts["bin"], pa.float64()), width), lo)
    out = pa.table(
        {
            "bin_start": starts,
            "bin_end": pc.add(starts, width),
            **({group: counts[group]} if group else {}),
            "count": counts["count_all"],
        }
    )
    return _answer(out, False)


def _points(table: pa.Table, x: str, ys: list[str], group: str | None, ordered: bool) -> dict[str, Any]:
    keep = list(dict.fromkeys([x, *ys, *([group] if group else [])]))
    t = table.select(keep).filter(pc.is_valid(table[x]))
    if ordered:
        t = t.sort_by([(x, "ascending")])
    truncated = t.num_rows > MAX_POINTS
    if truncated:
        # evenly spaced rows: the shape of the data, not its first rows
        step = t.num_rows / MAX_POINTS
        t = t.take(pa.array([int(i * step) for i in range(MAX_POINTS)], pa.int64()))
    return _answer(t, truncated)


def _aggregated(table: pa.Table, kind: str, x: str, ys: list[str], agg: str, group: str | None) -> dict[str, Any]:
    keys = [x] + ([group] if group else [])
    if agg == "count" or not ys:
        aggs: list[tuple[Any, str]] = [([], "count_all")]
        names = ["count"]
    else:
        aggs = [(y, _AGG[agg]) for y in ys]
        names = list(ys)
    grouped = table.select(list(dict.fromkeys(keys + [a[0] for a in aggs if a[0]]))).group_by(keys).aggregate(aggs)
    # pyarrow names results "<col>_<fn>": back to the value names, keys first
    t = pa.table({**{k: grouped[k] for k in keys}, **{n: grouped[_result_name(a)] for n, a in zip(names, aggs)}})
    t = t.filter(pc.is_valid(t[x]))
    xtype = t.schema.field(x).type
    by_value = kind == "bar" and not (_numeric(xtype) or pa.types.is_temporal(xtype))
    limit = MAX_BARS if kind == "bar" else MAX_LINE
    if by_value:
        # largest categories first (their total across groups)
        totals = t.group_by([x]).aggregate([(names[0], "sum")]).sort_by([(f"{names[0]}_sum", "descending")])
    else:
        totals = t.group_by([x]).aggregate([]).sort_by([(x, "ascending")])
    truncated = totals.num_rows > limit
    order = totals[x].slice(0, limit)
    t = t.filter(pc.is_in(t[x], value_set=order))
    rank = pa.table({x: order, "__rank": pa.array(range(len(order)), pa.int64())})
    t = t.join(rank, x).sort_by([("__rank", "ascending")] + ([(group, "ascending")] if group else [])).drop_columns(["__rank"])
    return _answer(t, truncated)


def _result_name(agg: tuple[Any, str]) -> str:
    column, fn = agg
    return "count_all" if fn == "count_all" else f"{column}_{fn}"


def _plain(table: pa.Table, names: list[str]) -> pa.Table:
    """The columns a chart uses, with view types (the engine's strings) cast
    to the plain ones pyarrow's filters and groupings support."""
    cols = {}
    for name in dict.fromkeys(names):
        col = table[name]
        if pa.types.is_string_view(col.type):
            col = col.cast(pa.large_string())
        elif pa.types.is_binary_view(col.type):
            col = col.cast(pa.large_binary())
        cols[name] = col
    return pa.table(cols)


def chart_data(table: pa.Table, spec: dict[str, Any]) -> dict[str, Any]:
    kind = spec.get("kind", "bar")
    x = _column(table, spec.get("x"))
    ys = [_column(table, y) for y in spec.get("y") or []]
    group = _column(table, spec["group"]) if spec.get("group") else None
    table = _plain(table, [x, *ys, *([group] if group else [])])
    if kind == "histogram":
        return _histogram(table, x, group, max(1, min(int(spec.get("bins") or 30), MAX_BINS)))
    agg = spec.get("agg") or "sum"
    if agg not in _AGG and agg != "none":
        raise ValueError(f"unknown aggregation {agg!r}")
    if kind == "scatter" or agg == "none":
        if not ys:
            raise ValueError("pick a value column")
        return _points(table, x, ys, group, ordered=kind in ("line", "area"))
    if kind not in ("bar", "line", "area"):
        raise ValueError(f"unknown chart kind {kind!r}")
    return _aggregated(table, kind, x, ys, agg, group)
