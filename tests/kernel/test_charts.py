"""Chart data computed in the kernel from stored results."""

from __future__ import annotations

import pyarrow as pa
import pytest

from iara.kernel.runtime import charts
from iara.kernel.runtime.charts import chart_data


@pytest.fixture()
def sales() -> pa.Table:
    n = 1000
    return pa.table(
        {
            "region": pa.array([["north", "south", "east"][i % 3] for i in range(n)], pa.string_view()),
            "year": [2020 + i % 4 for i in range(n)],
            "amount": [float(i % 10) for i in range(n)],
            "qty": [i % 7 for i in range(n)],
        }
    )


def test_bars_aggregate_by_category_largest_first(sales: pa.Table) -> None:
    out = chart_data(sales, {"kind": "bar", "x": "region", "y": ["amount"], "agg": "sum"})
    assert out["columns"] == ["region", "amount"]
    totals = {r: sum(float(i % 10) for i in range(1000) if ["north", "south", "east"][i % 3] == r) for r in ("north", "south", "east")}
    assert out["rows"] == sorted(([r, v] for r, v in totals.items()), key=lambda rv: -rv[1])
    assert not out["truncated"]


def test_counts_and_series_split_by_a_group(sales: pa.Table) -> None:
    out = chart_data(sales, {"kind": "line", "x": "year", "y": [], "agg": "count", "group": "region"})
    assert out["columns"] == ["year", "region", "count"]
    assert [r[0] for r in out["rows"]] == sorted(r[0] for r in out["rows"])  # lines follow x
    assert sum(r[2] for r in out["rows"]) == 1000
    assert len(out["rows"]) == 12  # 4 years x 3 regions


def test_many_categories_are_cut(sales: pa.Table, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(charts, "MAX_BARS", 2)
    out = chart_data(sales, {"kind": "bar", "x": "region", "y": ["qty", "amount"], "agg": "avg"})
    assert out["truncated"] and len(out["rows"]) == 2
    assert out["columns"] == ["region", "qty", "amount"]


def test_scatter_samples_evenly(sales: pa.Table, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(charts, "MAX_POINTS", 100)
    out = chart_data(sales, {"kind": "scatter", "x": "qty", "y": ["amount"], "agg": "none"})
    assert out["truncated"] and len(out["rows"]) == 100
    assert out["rows"][1] == [3, 0.0]  # every 10th row: the second is row 10 (qty 3, amount 0)


def test_histogram_bins_cover_the_range(sales: pa.Table) -> None:
    out = chart_data(sales, {"kind": "histogram", "x": "amount", "bins": 5})
    assert out["columns"] == ["bin_start", "bin_end", "count"]
    assert [r[0] for r in out["rows"]] == [0.0, 1.8, 3.6, 5.4, 7.2]
    assert sum(r[2] for r in out["rows"]) == 1000
    assert out["rows"][-1][1] == pytest.approx(9.0)


def test_bad_specs_explain_themselves(sales: pa.Table) -> None:
    with pytest.raises(ValueError, match="unknown column"):
        chart_data(sales, {"kind": "bar", "x": "nope", "y": ["amount"], "agg": "sum"})
    with pytest.raises(ValueError, match="numeric"):
        chart_data(sales, {"kind": "histogram", "x": "region"})
