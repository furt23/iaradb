"""P1 frame operations (fill/drop nulls and NaN, unique, sample, row index,
describe, union by name), checked against DuckDB."""

from __future__ import annotations

import datetime as dt
import os
import sys

import duckdb
import pyarrow as pa
import pytest

import workhouse as wh

sys.path.insert(0, os.path.dirname(__file__))
from compare import diff  # noqa: E402

N = 200


def _table() -> pa.Table:
    i = list(range(N))
    return pa.table(
        {
            "i": pa.array(i, type=pa.int64()),
            "g": pa.array([None if k % 17 == 0 else k % 4 for k in i], type=pa.int64()),
            "a": pa.array([None if k % 5 == 0 else k * 3 for k in i], type=pa.int64()),
            "b": pa.array(
                [None if k % 7 == 0 else (float("nan") if k % 11 == 0 else k / 4) for k in i],
                type=pa.float64(),
            ),
            "s": pa.array([None if k % 9 == 0 else ["é", "日本", "ß", "a b"][k % 4] for k in i]),
            "d": pa.array(
                [dt.date(2024, 2, 29) if k % 3 == 0 else dt.date(2023, 3, 1) for k in i],
                type=pa.date32(),
            ),
        }
    )


@pytest.fixture()
def src() -> pa.Table:
    return _table()


def _lf(t: pa.Table) -> wh.LazyFrame:
    return wh.from_arrow(t).lazy()


def _duck(t: pa.Table, sql: str) -> pa.Table:
    con = duckdb.connect()
    con.register("src", t)
    return con.execute(sql).arrow().read_all()


def _ours(lf: wh.LazyFrame) -> pa.Table:
    return lf.collect().to_arrow()


# ---- fill_null / fill_nan -------------------------------------------------
def test_fill_null_value_matches_duckdb(src: pa.Table) -> None:
    ours = _ours(_lf(src).fill_null(0, subset=["a"]).sort("i"))
    theirs = _duck(src, "select i, coalesce(a, 0) as a, g, b, s, d from src order by i")
    assert diff(ours.select(theirs.column_names), theirs, ordered=True) is None


def test_fill_null_forward_and_backward_match_duckdb(src: pa.Table) -> None:
    fwd = _ours(_lf(src).fill_null(strategy="forward", subset=["a"]).sort("i"))
    theirs = _duck(
        src,
        "select i, last_value(a ignore nulls) over (order by i rows between unbounded preceding "
        "and current row) as a from src order by i",
    )
    assert diff(fwd.select(["i", "a"]), theirs, ordered=True) is None
    bwd = _ours(_lf(src).fill_null(strategy="backward", subset=["a"]).sort("i"))
    theirs = _duck(
        src,
        "select i, first_value(a ignore nulls) over (order by i rows between current row "
        "and unbounded following) as a from src order by i",
    )
    assert diff(bwd.select(["i", "a"]), theirs, ordered=True) is None


def test_fill_null_mean_matches_duckdb(src: pa.Table) -> None:
    ours = _ours(_lf(src).fill_null(strategy="mean", subset=["a"]).sort("i")).column("a")
    theirs = _duck(src, "select coalesce(a, avg(a) over ()) as a from src order by i").column("a")
    assert ours.to_pylist() == pytest.approx(theirs.to_pylist())


def test_fill_nan_matches_duckdb(src: pa.Table) -> None:
    ours = _ours(_lf(src).fill_nan(-1.0).sort("i"))
    theirs = _duck(src, "select i, case when isnan(b) then -1.0 else b end as b from src order by i")
    assert diff(ours.select(["i", "b"]), theirs, ordered=True) is None


def test_fill_on_empty_and_unicode(src: pa.Table) -> None:
    empty = src.slice(0, 0)
    assert _ours(_lf(empty).fill_null(0, subset=["a"])).num_rows == 0
    assert _ours(_lf(empty).fill_nan(0.0)).num_rows == 0
    filled = _ours(_lf(src).fill_null("日本", subset=["s"])).column("s").to_pylist()
    assert filled[0] == "日本" and "é" in filled


# ---- drop_nulls / drop_nans -----------------------------------------------
def test_drop_nulls_matches_duckdb(src: pa.Table) -> None:
    ours = _ours(_lf(src).drop_nulls(["a", "s"]).sort("i"))
    theirs = _duck(src, "select * from src where a is not null and s is not null order by i")
    assert diff(ours, theirs, ordered=True) is None


def test_drop_nans_keeps_nulls_and_matches_duckdb(src: pa.Table) -> None:
    ours = _ours(_lf(src).drop_nans().sort("i"))
    theirs = _duck(src, "select * from src where b is null or not isnan(b) order by i")
    assert diff(ours, theirs, ordered=True) is None
    assert None in ours.column("b").to_pylist()


def test_drop_nans_rejects_non_float(src: pa.Table) -> None:
    with pytest.raises(TypeError):
        _lf(src).drop_nans(["a"])


def test_drop_nulls_on_empty(src: pa.Table) -> None:
    assert _ours(_lf(src.slice(0, 0)).drop_nulls()).num_rows == 0


# ---- unique ---------------------------------------------------------------
@pytest.mark.parametrize(
    "keep,qualify",
    [
        ("first", "row_number() over (partition by g order by i) = 1"),
        ("last", "row_number() over (partition by g order by i desc) = 1"),
        ("none", "count(*) over (partition by g) = 1"),
    ],
)
def test_unique_keep_matches_duckdb(src: pa.Table, keep: str, qualify: str) -> None:
    ours = _ours(_lf(src).unique(subset=["g"], keep=keep, maintain_order=True).sort("i"))
    theirs = _duck(src, f"select * from src qualify {qualify} order by i")
    assert diff(ours, theirs, ordered=True) is None


def test_unique_all_columns_matches_distinct(src: pa.Table) -> None:
    ours = _ours(_lf(src).unique())
    theirs = _duck(src, "select distinct * from src")
    assert diff(ours, theirs, ordered=False) is None


def test_drop_duplicates_is_unique(src: pa.Table) -> None:
    a = _ours(_lf(src).drop_duplicates(subset=["s"], keep="first").sort("s"))
    b = _ours(_lf(src).unique(subset=["s"], keep="first").sort("s"))
    assert diff(a, b, ordered=True) is None


def test_unique_rejects_bad_keep(src: pa.Table) -> None:
    with pytest.raises(ValueError):
        _lf(src).unique(keep="random")


def test_unique_on_empty(src: pa.Table) -> None:
    assert _ours(_lf(src.slice(0, 0)).unique(subset=["g"], keep="none")).num_rows == 0


# ---- sample ---------------------------------------------------------------
def test_sample_exact_size_deterministic_and_ordered(src: pa.Table) -> None:
    lf = _lf(src)
    a = _ours(lf.sample(n=30, seed=7))
    b = _ours(lf.sample(n=30, seed=7))
    c = _ours(lf.sample(n=30, seed=8))
    assert a.num_rows == 30
    assert diff(a, b, ordered=True) is None
    assert a.column("i").to_pylist() != c.column("i").to_pylist()
    ids = a.column("i").to_pylist()
    assert ids == sorted(ids) and len(set(ids)) == 30


def test_sample_fraction_and_spread(src: pa.Table) -> None:
    ids = _ours(_lf(src).sample(fraction=0.5, seed=3)).column("i").to_pylist()
    assert len(ids) == N // 2
    mean = sum(ids) / len(ids)
    assert N / 4 < mean < 3 * N / 4  # not clustered at one end


def test_sample_with_replacement(src: pa.Table) -> None:
    out = _ours(_lf(src).sample(n=3 * N, seed=1, with_replacement=True))
    assert out.num_rows == 3 * N
    assert set(out.column("i").to_pylist()) <= set(range(N))


def test_sample_edges(src: pa.Table) -> None:
    assert _ours(_lf(src).sample(n=0, seed=1)).num_rows == 0
    assert _ours(_lf(src.slice(0, 0)).sample(n=0, seed=1)).num_rows == 0
    with pytest.raises(ValueError):
        _lf(src).sample(n=N + 1, seed=1)
    with pytest.raises(ValueError):
        _lf(src).sample(seed=1)
    with pytest.raises(ValueError):
        _lf(src.slice(0, 0)).sample(n=1, seed=1, with_replacement=True)


# ---- with_row_index -------------------------------------------------------
def test_with_row_index_matches_duckdb(src: pa.Table) -> None:
    ours = _ours(_lf(src).with_row_index("idx", offset=10))
    assert ours.column_names[0] == "idx"
    theirs = _duck(src, "select row_number() over () + 9 as idx, i from src order by idx")
    assert ours.column("idx").to_pylist() == theirs.column("idx").to_pylist()
    assert ours.column("i").to_pylist() == theirs.column("i").to_pylist()


def test_with_row_index_rejects_existing_name(src: pa.Table) -> None:
    with pytest.raises(ValueError):
        _lf(src).with_row_index("i")


def test_with_row_index_on_empty(src: pa.Table) -> None:
    assert _ours(_lf(src.slice(0, 0)).with_row_index()).num_rows == 0


# ---- describe -------------------------------------------------------------
def test_describe_matches_duckdb(src: pa.Table) -> None:
    out = wh.from_arrow(src).describe().to_pydict()
    rows = dict(zip(out["statistic"], zip(*(out[c] for c in ["i", "a"]))))
    con = duckdb.connect()
    con.register("src", src)
    q = con.execute(
        "select count(a), count(*) - count(a), avg(a), stddev_samp(a), min(a), "
        "quantile_cont(a, 0.25), quantile_cont(a, 0.5), quantile_cont(a, 0.75), max(a) from src"
    ).fetchone()
    names = ["count", "null_count", "mean", "std", "min", "25%", "50%", "75%", "max"]
    for name, want in zip(names, q):
        got = rows[name][1]
        if want is None:
            assert got is None or got == "nan", name
        elif isinstance(want, (int, float)) and not isinstance(want, bool):
            assert float(got) == pytest.approx(float(want)), name
        else:
            assert got == str(want), name


def test_describe_strings_and_dates(src: pa.Table) -> None:
    out = wh.from_arrow(src).describe().to_pydict()
    s = dict(zip(out["statistic"], out["s"]))
    assert s["count"] == str(N - sum(1 for k in range(N) if k % 9 == 0))
    assert s["mean"] is None and s["25%"] is None
    d = dict(zip(out["statistic"], out["d"]))
    assert d["min"] == "2023-03-01" and d["max"] == "2024-02-29"


def test_describe_empty(src: pa.Table) -> None:
    out = wh.from_arrow(src.slice(0, 0)).describe().to_pydict()
    assert dict(zip(out["statistic"], out["i"]))["count"] == "0"
    assert dict(zip(out["statistic"], out["i"]))["mean"] is None


def test_summary_is_describe(src: pa.Table) -> None:
    df = wh.from_arrow(src)
    assert df.summary().to_pydict() == df.describe().to_pydict()


# ---- union_by_name / concat ----------------------------------------------
def test_union_by_name_matches_duckdb() -> None:
    t1 = pa.table({"a": pa.array([1, None], type=pa.int64()), "s": ["é", None]})
    t2 = pa.table(
        {
            "a": pa.array([2.5], type=pa.float64()),
            "d": pa.array([dt.date(2024, 2, 29)], type=pa.date32()),
        }
    )
    ours = _ours(_lf(t1).union_by_name(_lf(t2)))
    con = duckdb.connect()
    con.register("t1", t1)
    con.register("t2", t2)
    theirs = con.execute("select * from t1 union all by name select * from t2").arrow().read_all()
    assert diff(ours, theirs, ordered=False) is None
    assert ours.schema.field("a").type == pa.float64()
    assert ours.column("d").to_pylist()[-1] == dt.date(2024, 2, 29)


def test_concat_diagonal_accepts_dataframes_and_empty() -> None:
    a = wh.from_dict({"x": [1, 2]})
    b = wh.from_dict({"y": ["p"]})
    out = wh.concat([a, b], how="diagonal")
    assert isinstance(out, wh.DataFrame)
    assert out.to_pydict() == {"x": [1, 2, None], "y": [None, None, "p"]}
    empty = wh.from_arrow(pa.table({"x": pa.array([], type=pa.int64())}))
    assert wh.concat([empty, a], how="diagonal").height == 2


def test_concat_vertical_needs_same_columns() -> None:
    a = wh.from_dict({"x": [1]})
    assert wh.concat([a, a]).height == 2
    with pytest.raises(ValueError):
        wh.concat([a, wh.from_dict({"y": [1]})])
    with pytest.raises(ValueError):
        wh.concat([a], how="sideways")
