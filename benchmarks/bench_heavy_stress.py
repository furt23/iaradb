"""Heavy join + regex stress test: the five situations of examples/workspace/notebooks/heavy_stress_tests.py.

usage: python benchmarks/bench_heavy_stress.py <tpch_data_dir> [--runs N] [--engines iara,iara-sql,duckdb,polars] [--queries 1,2]
                                               [--timeout S] [--validate] [--json out.json]

Q1..Q4 are the notebook's four DataFrame pipelines, Q5 is its SQL query (Q1 with LIMIT 20).
Engines: iara (LazyFrame API, as in the notebook), iara-sql, duckdb, polars (lazy DataFrame API),
datafusion (SQL). Sorts carry tie-breakers so engines can be validated against each other.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import harness  # noqa: E402
from tpch_queries import TABLES  # noqa: E402

CUST_CMT = r"(?i)\b(unusual|special|express|requests?|complaint|account)\b"
PTYPE = r"^(?:PROMO|STANDARD|SMALL|MEDIUM|LARGE)\s+([A-Z]+)\s+([A-Z]+)$"
SHIPINSTR = r"(?i)\b(deliver in person|collect cod|take back return)\b"
ORD_CMT2 = r"(?i)\b(carefully|express|urgent|special|packages)\b"
SUPP_CMT3 = r"(?i)\b(unusual|recommends?|special)\b"
ORD_CMT4 = r"(?i)\b(urgent|express|rush|critical|special)\b"

_S1 = f"""
SELECT r_name, n_name,
       nullif(regexp_extract(p_type, '{PTYPE}', 2), '') AS alloy_metal,
       nullif(regexp_extract(p_type, '{PTYPE}', 1), '') AS material_finish,
       count(DISTINCT c_custkey) AS affected_customers,
       count(DISTINCT o_orderkey) AS total_orders_audited,
       sum(l_quantity) AS total_parts_delivered,
       sum(l_extendedprice) AS total_exposure_usd
FROM customer
JOIN nation ON c_nationkey = n_nationkey
JOIN region ON n_regionkey = r_regionkey
JOIN orders ON c_custkey = o_custkey
JOIN lineitem ON o_orderkey = l_orderkey
JOIN part ON l_partkey = p_partkey
JOIN supplier ON l_suppkey = s_suppkey
WHERE c_mktsegment = 'AUTOMOBILE' AND c_acctbal > 5000 AND regexp_matches(c_comment, '{CUST_CMT}')
GROUP BY 1, 2, 3, 4
ORDER BY total_exposure_usd DESC, r_name, n_name, alloy_metal, material_finish"""

SQL = {
    1: _S1,
    2: f"""
SELECT sn.n_name AS supplier_nation, cn.n_name AS customer_nation, l_shipmode,
       count(*) AS cross_border_shipments,
       count(DISTINCT l_orderkey) AS unique_orders,
       sum(l_extendedprice * (1 - l_discount)) AS total_net_revenue,
       avg(l_discount) AS avg_discount
FROM lineitem
JOIN orders ON l_orderkey = o_orderkey
JOIN customer ON o_custkey = c_custkey
JOIN nation cn ON c_nationkey = cn.n_nationkey
JOIN supplier ON l_suppkey = s_suppkey
JOIN nation sn ON s_nationkey = sn.n_nationkey
WHERE regexp_matches(l_shipinstruct, '{SHIPINSTR}') AND l_discount > 0.04
  AND regexp_matches(o_comment, '{ORD_CMT2}') AND cn.n_name <> sn.n_name
GROUP BY 1, 2, 3
ORDER BY total_net_revenue DESC, supplier_nation, customer_nation, l_shipmode""",
    3: f"""
SELECT r_name, p_mfgr, p_container,
       count(DISTINCT p_partkey) AS parts_catalogued,
       avg(p_retailprice) AS avg_retail_price,
       avg(ps_supplycost) AS avg_supplier_cost,
       max(p_retailprice - ps_supplycost) AS max_margin,
       avg(len(regexp_extract_all(p_comment, '[a-zA-Z]+'))) AS avg_spec_words
FROM part
JOIN partsupp ON p_partkey = ps_partkey
JOIN supplier ON ps_suppkey = s_suppkey
JOIN nation ON s_nationkey = n_nationkey
JOIN region ON n_regionkey = r_regionkey
WHERE regexp_matches(s_comment, '{SUPP_CMT3}') AND p_retailprice - ps_supplycost > 0
GROUP BY 1, 2, 3
ORDER BY max_margin DESC, r_name, p_mfgr, p_container""",
    4: f"""
SELECT n_name, l_shipmode, o_orderpriority,
       count(*) AS delayed_shipments,
       count(DISTINCT o_orderkey) AS impacted_orders,
       sum(l_extendedprice * (1 - l_discount)) AS total_delayed_revenue
FROM orders
JOIN lineitem ON o_orderkey = l_orderkey
JOIN customer ON o_custkey = c_custkey
JOIN nation ON c_nationkey = n_nationkey
WHERE regexp_matches(o_comment, '{ORD_CMT4}') AND o_orderstatus = 'O' AND l_receiptdate > l_commitdate
GROUP BY 1, 2, 3
ORDER BY total_delayed_revenue DESC, n_name, l_shipmode, o_orderpriority
LIMIT 50""",
    5: _S1 + "\nLIMIT 20",
}


# ------------------------------------------------------------ DataFrame pipelines
# Iara's and Polars' LazyFrame APIs match for everything used here, only the column helper differs.


def pipelines(t, col, len_):
    """Q1..Q4 over lazy frames `t` (table name -> frame); `col` builds a column expression, `len_` is count(*)."""
    c = col

    def x(e, pat, g):
        return e.str.extract(pat, g)

    def q1():
        return (
            t["customer"]
            .filter((c("c_mktsegment") == "AUTOMOBILE") & (c("c_acctbal") > 5000) & c("c_comment").str.contains(CUST_CMT))
            .join(t["nation"], left_on="c_nationkey", right_on="n_nationkey")
            .join(t["region"], left_on="n_regionkey", right_on="r_regionkey")
            .join(t["orders"], left_on="c_custkey", right_on="o_custkey")
            .join(t["lineitem"], left_on="o_orderkey", right_on="l_orderkey")
            .join(t["part"], left_on="l_partkey", right_on="p_partkey")
            .join(t["supplier"], left_on="l_suppkey", right_on="s_suppkey")
            .with_columns(
                issue_phrase=x(c("c_comment"), r"([a-z]+(?: [a-z]+)* (?:account|request|deposit|package))", 1),
                material_finish=x(c("p_type"), PTYPE, 1),
                alloy_metal=x(c("p_type"), PTYPE, 2),
                supplier_sentiment=x(c("s_comment"), r"Customer ([a-zA-Z]+)", 1),
                redacted_phone=c("c_phone").str.replace_all(r"(\d{2})-(\d{3})-(\d{3})-(\d{4})", "$1-$2-XXX-$4"),
            )
            .group_by("r_name", "n_name", "alloy_metal", "material_finish")
            .agg(
                affected_customers=c("c_custkey").n_unique(),
                total_orders_audited=c("o_orderkey").n_unique(),
                total_parts_delivered=c("l_quantity").sum(),
                total_exposure_usd=c("l_extendedprice").sum(),
            )
            .sort(["total_exposure_usd", "r_name", "n_name", "alloy_metal", "material_finish"], descending=[True, False, False, False, False])
        )

    def q2():
        cn = t["nation"].select(n_nationkey_cust=c("n_nationkey"), customer_nation=c("n_name"))
        sn = t["nation"].select(n_nationkey_supp=c("n_nationkey"), supplier_nation=c("n_name"))
        return (
            t["lineitem"]
            .filter(c("l_shipinstruct").str.contains(SHIPINSTR) & (c("l_discount") > 0.04))
            .join(t["orders"], left_on="l_orderkey", right_on="o_orderkey")
            .filter(c("o_comment").str.contains(ORD_CMT2))
            .join(t["customer"], left_on="o_custkey", right_on="c_custkey")
            .join(cn, left_on="c_nationkey", right_on="n_nationkey_cust")
            .join(t["supplier"], left_on="l_suppkey", right_on="s_suppkey")
            .join(sn, left_on="s_nationkey", right_on="n_nationkey_supp")
            .filter(c("customer_nation") != c("supplier_nation"))
            .with_columns(
                cargo_instruction=x(c("l_comment"), r"([a-z]+(?: [a-z]+)* (?:packages|requests|instructions|deposits))", 1),
                supplier_flag=x(c("s_comment"), r"(?i)\b(complaints?|recommends?|special requests?)\b", 1),
                net_line_revenue=c("l_extendedprice") * (1 - c("l_discount")),
            )
            .group_by("supplier_nation", "customer_nation", "l_shipmode")
            .agg(
                cross_border_shipments=len_(),
                unique_orders=c("l_orderkey").n_unique(),
                total_net_revenue=c("net_line_revenue").sum(),
                avg_discount=c("l_discount").mean(),
            )
            .sort(["total_net_revenue", "supplier_nation", "customer_nation", "l_shipmode"], descending=[True, False, False, False])
        )

    def q3():
        return (
            t["part"]
            .join(t["partsupp"], left_on="p_partkey", right_on="ps_partkey")
            .join(t["supplier"], left_on="ps_suppkey", right_on="s_suppkey")
            .join(t["nation"], left_on="s_nationkey", right_on="n_nationkey")
            .join(t["region"], left_on="n_regionkey", right_on="r_regionkey")
            .filter(c("s_comment").str.contains(SUPP_CMT3))
            .with_columns(
                part_color_token=x(c("p_name"), r"\b([a-z]+)\s+([a-z]+)$", 1),
                spec_word_count=c("p_comment").str.count_matches(r"[a-zA-Z]+"),
                margin_spread=c("p_retailprice") - c("ps_supplycost"),
            )
            .filter(c("margin_spread") > 0)
            .group_by("r_name", "p_mfgr", "p_container")
            .agg(
                parts_catalogued=c("p_partkey").n_unique(),
                avg_retail_price=c("p_retailprice").mean(),
                avg_supplier_cost=c("ps_supplycost").mean(),
                max_margin=c("margin_spread").max(),
                avg_spec_words=c("spec_word_count").mean(),
            )
            .sort(["max_margin", "r_name", "p_mfgr", "p_container"], descending=[True, False, False, False])
        )

    def q4():
        return (
            t["orders"]
            .filter(c("o_comment").str.contains(ORD_CMT4) & (c("o_orderstatus") == "O"))
            .join(t["lineitem"], left_on="o_orderkey", right_on="l_orderkey")
            .filter(c("l_receiptdate") > c("l_commitdate"))
            .join(t["customer"], left_on="o_custkey", right_on="c_custkey")
            .join(t["nation"], left_on="c_nationkey", right_on="n_nationkey")
            .with_columns(
                courier_note=x(c("l_comment"), r"([a-z]+(?: [a-z]+)* (?:packages|requests|instructions|deposits))", 1),
                delayed_order_revenue=c("l_extendedprice") * (1 - c("l_discount")),
            )
            .group_by("n_name", "l_shipmode", "o_orderpriority")
            .agg(
                delayed_shipments=len_(),
                impacted_orders=c("o_orderkey").n_unique(),
                total_delayed_revenue=c("delayed_order_revenue").sum(),
            )
            .sort(["total_delayed_revenue", "n_name", "l_shipmode", "o_orderpriority"], descending=[True, False, False, False])
            .limit(50)
        )

    return {1: q1, 2: q2, 3: q3, 4: q4, 5: lambda: q1().limit(20)}


def setup_iara_api(tables, queries):
    import iara as ia
    from iara import functions as F

    t = {n: ia.scan_parquet(p.replace("\\", "/")) for n, p in tables.items()}
    P = pipelines(t, F.col, F.len)
    return lambda q: P[q]().collect().to_arrow()


def setup_polars_api(tables, queries):
    import polars as pl

    t = {n: pl.scan_parquet(harness._glob(p)) for n, p in tables.items()}
    P = pipelines(t, pl.col, pl.len)
    return lambda q: P[q]().collect(engine="auto").to_arrow()


def setup_datafusion(tables, queries):
    # DataFusion spells the regex functions differently
    q = {k: v.replace("regexp_matches(", "regexp_like(") for k, v in queries.items()}
    return harness.setup_datafusion(tables, q)


SETUPS = {
    "iara": setup_iara_api,
    "iara-sql": harness.setup_iara,
    "duckdb": harness.setup_duckdb,
    "polars": setup_polars_api,
    "datafusion": setup_datafusion,
}


def tables(data: str) -> dict[str, str]:
    return {t: os.path.join(data, t) for t in TABLES}


if __name__ == "__main__":
    harness.main("heavy_stress", tables, SQL, SETUPS, "iara,iara-sql,duckdb,polars")
