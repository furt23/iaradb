"""Parquet scan shortcuts checked against DuckDB: ungrouped MIN/MAX/COUNT
from row-group statistics, a top k's running bound pushed into the scan
(rows and row groups past it are skipped), late materialization with rows
filtered while decoding, and regex kernels that evaluate repeated strings
once and split a trailing `.*` off capture searches.
"""

from __future__ import annotations

import os
import sys

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import iara as ia

sys.path.insert(0, os.path.dirname(__file__))
from compare import diff  # noqa: E402

N = 120_000


@pytest.fixture(scope="module")
def path(tmp_path_factory) -> str:
    rng = np.random.default_rng(11)
    t = rng.integers(0, 10_000_000, N)
    t_null = np.where(rng.random(N) < 0.02, None, t)
    hosts = [f"www.site{i}.com" for i in range(40)] + [f"shop{i}.org" for i in range(20)]
    url = [f"https://{hosts[h]}/p/{p}" for h, p in zip(rng.integers(0, len(hosts), N), rng.integers(0, 300, N))]
    url = [u + "\nline" if i % 997 == 0 else u for i, u in enumerate(url)]
    table = pa.table(
        {
            "id": pa.array(np.arange(N), pa.int64()),
            "t": pa.array(t, pa.int64()),
            "tn": pa.array(t_null, pa.int64()),
            "ts": pa.array(t * 1_000_000, pa.timestamp("us")),
            "d": pa.array((t // 1000).astype("int32"), pa.date32()),
            "f": pa.array(rng.normal(0, 1, N), pa.float64()),
            "s": pa.array([f"s{x % 5000}" for x in t]),
            "url": pa.array(url),
            "w1": pa.array(rng.integers(0, 100, N), pa.int32()),
            "w2": pa.array([f"word{x}" for x in rng.integers(0, 1000, N)]),
        }
    )
    p = str(tmp_path_factory.mktemp("scan") / "t.parquet")
    pq.write_table(table, p, row_group_size=10_000)
    return p


def check(path: str, query: str, ordered: bool = False) -> None:
    ctx = ia.SessionContext()
    ctx.register_parquet("t", path)
    ours = ctx.sql(query).collect().to_arrow()
    con = duckdb.connect()
    con.execute(f"CREATE VIEW t AS SELECT * FROM read_parquet('{path}')")
    exp = con.execute(query).to_arrow_table()
    d = diff(ours, exp, ordered=ordered, rtol=1e-9)
    assert d is None, f"{query}: {d}"


def explain(path: str, query: str) -> str:
    ctx = ia.SessionContext()
    ctx.register_parquet("t", path)
    return ctx.sql(query).explain()


def test_min_max_count_from_statistics(path: str) -> None:
    q = "select min(t) a, max(t) b, min(d) c, max(ts) e, count(*) n, count(tn) m, min(tn) x from t"
    check(path, q)
    assert "Values" in explain(path, q)
    # floats (NaN is not in statistics), strings and filtered scans are read
    for q in ["select min(f), max(f) from t", "select max(s) from t", "select min(t) from t where w1 < 5"]:
        check(path, q)
        assert "Values" not in explain(path, q), q


@pytest.mark.parametrize(
    "query",
    [
        "select id, s from t order by t limit 10",
        "select id, s from t order by t desc limit 10",
        "select * from t where url like '%site3%' order by ts limit 25",
        "select * from t where w1 < 3 order by tn desc nulls last, id limit 7",
        "select * from t order by tn nulls first, id limit 9",
        "select s, w2 from t where s <> 's1' order by d, id limit 12",
        "select q.id from (select id, f as k from t) q order by k desc limit 6",
        "select id, url from t where url like '%shop1%' order by f limit 3000",
        "select w1, count(*) c from t group by w1 order by c desc, w1 limit 5",
    ],
)
def test_top_k_with_a_running_bound(path: str, query: str) -> None:
    check(path, query, ordered=True)


def test_late_filter_keeps_positions(path: str) -> None:
    # every row group decodes `url` first; the other columns are read by position
    for k in [1, 5, 50]:
        check(path, f"select * from t where url like '%site1%' and w1 < 50 order by t, id limit {k}", ordered=True)


@pytest.mark.parametrize(
    "expr",
    [
        r"regexp_replace(url, '^https?://(?:www\.)?([^/]+)/.*$', '\1')",
        r"regexp_replace(url, 'https?://([^/]+)/.*', '<\1>')",
        r"regexp_replace(url, '/p/.*$', '')",
        r"regexp_extract(url, '^https://([a-z]+)[0-9]+\.(com|org).*$', 1)",
        r"regexp_matches(url, 'site1[0-9]')",
    ],
)
def test_regex_on_repeated_strings(path: str, expr: str) -> None:
    check(path, f"select id, {expr} r from t")


@pytest.mark.parametrize(
    "query",
    [
        "select 1 one, s, count(*) c from t group by 1, s",
        "select w1, w1 - 1 a, w1 * 2 b, count(*) c from t group by w1, w1 - 1, w1 * 2",
        "select w1, 'x' k, sum(f) s from t group by w1, 'x' having count(*) > 10",
        "select w2, length(w2) l, count(*) c, min(id) m from t group by w2, length(w2)",
        "select tn, tn + 1 n1, count(*) c from t group by tn, tn + 1",
        # constants alone: an empty input has no group
        "select 1 one, count(*) c from t where w1 > 1000 group by 1",
    ],
)
def test_group_keys_derived_from_other_keys(path: str, query: str) -> None:
    check(path, query)
