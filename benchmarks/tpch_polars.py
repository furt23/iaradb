"""TPC-H queries written with the native Polars lazy API (pdsh style), so
Polars is benchmarked at its best rather than through its SQL frontend."""

from __future__ import annotations

import os
from datetime import date

import polars as pl


def tables(data: str) -> dict[str, pl.LazyFrame]:
    names = ["lineitem", "orders", "customer", "part", "partsupp", "supplier", "nation", "region"]
    return {n: pl.scan_parquet(os.path.join(data, n, "*.parquet")) for n in names}


def _rev() -> pl.Expr:
    return pl.col("l_extendedprice") * (1 - pl.col("l_discount"))


def q1(t):
    return (
        t["lineitem"]
        .filter(pl.col("l_shipdate") <= date(1998, 9, 2))
        .group_by("l_returnflag", "l_linestatus")
        .agg(
            pl.sum("l_quantity").alias("sum_qty"),
            pl.sum("l_extendedprice").alias("sum_base_price"),
            _rev().sum().alias("sum_disc_price"),
            (_rev() * (1 + pl.col("l_tax"))).sum().alias("sum_charge"),
            pl.mean("l_quantity").alias("avg_qty"),
            pl.mean("l_extendedprice").alias("avg_price"),
            pl.mean("l_discount").alias("avg_disc"),
            pl.len().alias("count_order"),
        )
        .sort("l_returnflag", "l_linestatus")
    )


def q2(t):
    europe = (
        t["region"]
        .filter(pl.col("r_name") == "EUROPE")
        .join(t["nation"], left_on="r_regionkey", right_on="n_regionkey")
        .join(t["supplier"], left_on="n_nationkey", right_on="s_nationkey")
        .join(t["partsupp"], left_on="s_suppkey", right_on="ps_suppkey")
    )
    brass = (
        t["part"]
        .filter((pl.col("p_size") == 15) & pl.col("p_type").str.ends_with("BRASS"))
        .join(europe, left_on="p_partkey", right_on="ps_partkey")
    )
    min_cost = brass.group_by("p_partkey").agg(pl.min("ps_supplycost").alias("min_cost"))
    return (
        brass.join(min_cost, on="p_partkey")
        .filter(pl.col("ps_supplycost") == pl.col("min_cost"))
        .select("s_acctbal", "s_name", "n_name", "p_partkey", "p_mfgr", "s_address", "s_phone", "s_comment")
        .sort(["s_acctbal", "n_name", "s_name", "p_partkey"], descending=[True, False, False, False])
        .head(100)
    )


def q3(t):
    c = t["customer"].filter(pl.col("c_mktsegment") == "BUILDING")
    o = t["orders"].filter(pl.col("o_orderdate") < date(1995, 3, 15))
    l = t["lineitem"].filter(pl.col("l_shipdate") > date(1995, 3, 15))
    return (
        c.join(o, left_on="c_custkey", right_on="o_custkey")
        .join(l, left_on="o_orderkey", right_on="l_orderkey")
        .group_by("o_orderkey", "o_orderdate", "o_shippriority")
        .agg(_rev().sum().alias("revenue"))
        .select(pl.col("o_orderkey").alias("l_orderkey"), "revenue", "o_orderdate", "o_shippriority")
        .sort(["revenue", "o_orderdate"], descending=[True, False])
        .head(10)
    )


def q4(t):
    l = t["lineitem"].filter(pl.col("l_commitdate") < pl.col("l_receiptdate"))
    o = t["orders"].filter(pl.col("o_orderdate").is_between(date(1993, 7, 1), date(1993, 10, 1), closed="left"))
    return (
        o.join(l, left_on="o_orderkey", right_on="l_orderkey", how="semi")
        .group_by("o_orderpriority")
        .agg(pl.len().alias("order_count"))
        .sort("o_orderpriority")
    )


def q5(t):
    return (
        t["region"]
        .filter(pl.col("r_name") == "ASIA")
        .join(t["nation"], left_on="r_regionkey", right_on="n_regionkey")
        .join(t["customer"], left_on="n_nationkey", right_on="c_nationkey")
        .join(t["orders"], left_on="c_custkey", right_on="o_custkey")
        .filter(pl.col("o_orderdate").is_between(date(1994, 1, 1), date(1995, 1, 1), closed="left"))
        .join(t["lineitem"], left_on="o_orderkey", right_on="l_orderkey")
        .join(t["supplier"], left_on=["l_suppkey", "n_nationkey"], right_on=["s_suppkey", "s_nationkey"])
        .group_by("n_name")
        .agg(_rev().sum().alias("revenue"))
        .sort("revenue", descending=True)
    )


def q6(t):
    return (
        t["lineitem"]
        .filter(
            pl.col("l_shipdate").is_between(date(1994, 1, 1), date(1995, 1, 1), closed="left")
            & pl.col("l_discount").is_between(0.05, 0.07)
            & (pl.col("l_quantity") < 24)
        )
        .select((pl.col("l_extendedprice") * pl.col("l_discount")).sum().alias("revenue"))
    )


def q7(t):
    def side(a: str, b: str):
        n1 = t["nation"].filter(pl.col("n_name") == a)
        n2 = t["nation"].filter(pl.col("n_name") == b)
        return (
            t["customer"]
            .join(n1, left_on="c_nationkey", right_on="n_nationkey")
            .join(t["orders"], left_on="c_custkey", right_on="o_custkey")
            .rename({"n_name": "cust_nation"})
            .join(t["lineitem"], left_on="o_orderkey", right_on="l_orderkey")
            .join(t["supplier"], left_on="l_suppkey", right_on="s_suppkey")
            .join(n2, left_on="s_nationkey", right_on="n_nationkey")
            .rename({"n_name": "supp_nation"})
            .select("supp_nation", "cust_nation", "l_shipdate", "l_extendedprice", "l_discount")
        )

    return (
        pl.concat([side("FRANCE", "GERMANY"), side("GERMANY", "FRANCE")])
        .filter(pl.col("l_shipdate").is_between(date(1995, 1, 1), date(1996, 12, 31)))
        .with_columns(_rev().alias("volume"), pl.col("l_shipdate").dt.year().alias("l_year"))
        .group_by("supp_nation", "cust_nation", "l_year")
        .agg(pl.sum("volume").alias("revenue"))
        .sort("supp_nation", "cust_nation", "l_year")
    )


def q8(t):
    n1 = t["nation"].select("n_nationkey", "n_regionkey")
    n2 = t["nation"].select("n_nationkey", "n_name")
    return (
        t["part"]
        .filter(pl.col("p_type") == "ECONOMY ANODIZED STEEL")
        .join(t["lineitem"], left_on="p_partkey", right_on="l_partkey")
        .join(t["supplier"], left_on="l_suppkey", right_on="s_suppkey")
        .join(t["orders"], left_on="l_orderkey", right_on="o_orderkey")
        .filter(pl.col("o_orderdate").is_between(date(1995, 1, 1), date(1996, 12, 31)))
        .join(t["customer"], left_on="o_custkey", right_on="c_custkey")
        .join(n1, left_on="c_nationkey", right_on="n_nationkey")
        .join(t["region"].filter(pl.col("r_name") == "AMERICA"), left_on="n_regionkey", right_on="r_regionkey")
        .join(n2, left_on="s_nationkey", right_on="n_nationkey")
        .select(
            pl.col("o_orderdate").dt.year().alias("o_year"),
            _rev().alias("volume"),
            pl.col("n_name").alias("nation"),
        )
        .group_by("o_year")
        .agg(
            (pl.when(pl.col("nation") == "BRAZIL").then(pl.col("volume")).otherwise(0).sum() / pl.col("volume").sum()).alias(
                "mkt_share"
            )
        )
        .sort("o_year")
    )


def q9(t):
    return (
        t["part"]
        .filter(pl.col("p_name").str.contains("green", literal=True))
        .join(t["partsupp"], left_on="p_partkey", right_on="ps_partkey")
        .join(t["supplier"], left_on="ps_suppkey", right_on="s_suppkey")
        .join(t["lineitem"], left_on=["p_partkey", "ps_suppkey"], right_on=["l_partkey", "l_suppkey"])
        .join(t["orders"], left_on="l_orderkey", right_on="o_orderkey")
        .join(t["nation"], left_on="s_nationkey", right_on="n_nationkey")
        .select(
            pl.col("n_name").alias("nation"),
            pl.col("o_orderdate").dt.year().alias("o_year"),
            (_rev() - pl.col("ps_supplycost") * pl.col("l_quantity")).alias("amount"),
        )
        .group_by("nation", "o_year")
        .agg(pl.sum("amount").alias("sum_profit"))
        .sort(["nation", "o_year"], descending=[False, True])
    )


def q10(t):
    return (
        t["customer"]
        .join(
            t["orders"].filter(pl.col("o_orderdate").is_between(date(1993, 10, 1), date(1994, 1, 1), closed="left")),
            left_on="c_custkey",
            right_on="o_custkey",
        )
        .join(t["lineitem"].filter(pl.col("l_returnflag") == "R"), left_on="o_orderkey", right_on="l_orderkey")
        .join(t["nation"], left_on="c_nationkey", right_on="n_nationkey")
        .group_by("c_custkey", "c_name", "c_acctbal", "c_phone", "n_name", "c_address", "c_comment")
        .agg(_rev().sum().alias("revenue"))
        .select("c_custkey", "c_name", "revenue", "c_acctbal", "n_name", "c_address", "c_phone", "c_comment")
        .sort("revenue", descending=True)
        .head(20)
    )


def q11(t):
    q = (
        t["partsupp"]
        .join(t["supplier"], left_on="ps_suppkey", right_on="s_suppkey")
        .join(t["nation"].filter(pl.col("n_name") == "GERMANY"), left_on="s_nationkey", right_on="n_nationkey")
    )
    value = pl.col("ps_supplycost") * pl.col("ps_availqty")
    threshold = q.select((value.sum() * 0.0001).alias("threshold"))
    return (
        q.group_by("ps_partkey")
        .agg(value.sum().alias("value"))
        .join(threshold, how="cross")
        .filter(pl.col("value") > pl.col("threshold"))
        .select("ps_partkey", "value")
        .sort("value", descending=True)
    )


def q12(t):
    high = pl.col("o_orderpriority").is_in(["1-URGENT", "2-HIGH"])
    return (
        t["orders"]
        .join(
            t["lineitem"].filter(
                pl.col("l_shipmode").is_in(["MAIL", "SHIP"])
                & (pl.col("l_commitdate") < pl.col("l_receiptdate"))
                & (pl.col("l_shipdate") < pl.col("l_commitdate"))
                & pl.col("l_receiptdate").is_between(date(1994, 1, 1), date(1995, 1, 1), closed="left")
            ),
            left_on="o_orderkey",
            right_on="l_orderkey",
        )
        .group_by("l_shipmode")
        .agg(
            pl.when(high).then(1).otherwise(0).sum().alias("high_line_count"),
            pl.when(~high).then(1).otherwise(0).sum().alias("low_line_count"),
        )
        .sort("l_shipmode")
    )


def q13(t):
    o = t["orders"].filter(~pl.col("o_comment").str.contains("special.*requests"))
    return (
        t["customer"]
        .join(o, left_on="c_custkey", right_on="o_custkey", how="left")
        .group_by("c_custkey")
        .agg(pl.col("o_orderkey").count().alias("c_count"))
        .group_by("c_count")
        .agg(pl.len().alias("custdist"))
        .sort(["custdist", "c_count"], descending=[True, True])
    )


def q14(t):
    return (
        t["lineitem"]
        .filter(pl.col("l_shipdate").is_between(date(1995, 9, 1), date(1995, 10, 1), closed="left"))
        .join(t["part"], left_on="l_partkey", right_on="p_partkey")
        .select(
            (
                100.00
                * pl.when(pl.col("p_type").str.starts_with("PROMO")).then(_rev()).otherwise(0).sum()
                / _rev().sum()
            ).alias("promo_revenue")
        )
    )


def q15(t):
    revenue = (
        t["lineitem"]
        .filter(pl.col("l_shipdate").is_between(date(1996, 1, 1), date(1996, 4, 1), closed="left"))
        .group_by("l_suppkey")
        .agg(_rev().sum().alias("total_revenue"))
        .select(pl.col("l_suppkey").alias("supplier_no"), "total_revenue")
    )
    return (
        t["supplier"]
        .join(revenue, left_on="s_suppkey", right_on="supplier_no")
        .filter(pl.col("total_revenue") == pl.col("total_revenue").max())
        .select("s_suppkey", "s_name", "s_address", "s_phone", "total_revenue")
        .sort("s_suppkey")
    )


def q16(t):
    complaints = t["supplier"].filter(pl.col("s_comment").str.contains(".*Customer.*Complaints.*")).select("s_suppkey")
    return (
        t["part"]
        .filter(
            (pl.col("p_brand") != "Brand#45")
            & ~pl.col("p_type").str.starts_with("MEDIUM POLISHED")
            & pl.col("p_size").is_in([49, 14, 23, 45, 19, 3, 36, 9])
        )
        .join(t["partsupp"], left_on="p_partkey", right_on="ps_partkey")
        .join(complaints, left_on="ps_suppkey", right_on="s_suppkey", how="anti")
        .group_by("p_brand", "p_type", "p_size")
        .agg(pl.col("ps_suppkey").n_unique().alias("supplier_cnt"))
        .sort(["supplier_cnt", "p_brand", "p_type", "p_size"], descending=[True, False, False, False])
    )


def q17(t):
    p = (
        t["part"]
        .filter((pl.col("p_brand") == "Brand#23") & (pl.col("p_container") == "MED BOX"))
        .join(t["lineitem"], left_on="p_partkey", right_on="l_partkey")
    )
    return (
        p.group_by("p_partkey")
        .agg((0.2 * pl.col("l_quantity").mean()).alias("avg_quantity"))
        .join(p, on="p_partkey")
        .filter(pl.col("l_quantity") < pl.col("avg_quantity"))
        .select((pl.col("l_extendedprice").sum() / 7.0).alias("avg_yearly"))
    )


def q18(t):
    big = t["lineitem"].group_by("l_orderkey").agg(pl.col("l_quantity").sum().alias("s")).filter(pl.col("s") > 300)
    return (
        t["orders"]
        .join(big, left_on="o_orderkey", right_on="l_orderkey", how="semi")
        .join(t["lineitem"], left_on="o_orderkey", right_on="l_orderkey")
        .join(t["customer"], left_on="o_custkey", right_on="c_custkey")
        .group_by("c_name", "o_custkey", "o_orderkey", "o_orderdate", "o_totalprice")
        .agg(pl.col("l_quantity").sum().alias("sum_qty"))
        .select("c_name", pl.col("o_custkey").alias("c_custkey"), "o_orderkey", "o_orderdate", "o_totalprice", "sum_qty")
        .sort(["o_totalprice", "o_orderdate"], descending=[True, False])
        .head(100)
    )


def q19(t):
    return (
        t["part"]
        .join(t["lineitem"], left_on="p_partkey", right_on="l_partkey")
        .filter(
            pl.col("l_shipmode").is_in(["AIR", "AIR REG"])
            & (pl.col("l_shipinstruct") == "DELIVER IN PERSON")
            & (
                (
                    (pl.col("p_brand") == "Brand#12")
                    & pl.col("p_container").is_in(["SM CASE", "SM BOX", "SM PACK", "SM PKG"])
                    & pl.col("l_quantity").is_between(1, 11)
                    & pl.col("p_size").is_between(1, 5)
                )
                | (
                    (pl.col("p_brand") == "Brand#23")
                    & pl.col("p_container").is_in(["MED BAG", "MED BOX", "MED PKG", "MED PACK"])
                    & pl.col("l_quantity").is_between(10, 20)
                    & pl.col("p_size").is_between(1, 10)
                )
                | (
                    (pl.col("p_brand") == "Brand#34")
                    & pl.col("p_container").is_in(["LG CASE", "LG BOX", "LG PACK", "LG PKG"])
                    & pl.col("l_quantity").is_between(20, 30)
                    & pl.col("p_size").is_between(1, 15)
                )
            )
        )
        .select(_rev().sum().alias("revenue"))
    )


def q20(t):
    qty = (
        t["lineitem"]
        .filter(pl.col("l_shipdate").is_between(date(1994, 1, 1), date(1995, 1, 1), closed="left"))
        .group_by("l_partkey", "l_suppkey")
        .agg((pl.col("l_quantity").sum() * 0.5).alias("sum_quantity"))
    )
    canada = t["supplier"].join(t["nation"].filter(pl.col("n_name") == "CANADA"), left_on="s_nationkey", right_on="n_nationkey")
    return (
        t["part"]
        .filter(pl.col("p_name").str.starts_with("forest"))
        .select("p_partkey")
        .unique()
        .join(t["partsupp"], left_on="p_partkey", right_on="ps_partkey")
        .join(qty, left_on=["ps_suppkey", "p_partkey"], right_on=["l_suppkey", "l_partkey"])
        .filter(pl.col("ps_availqty") > pl.col("sum_quantity"))
        .select("ps_suppkey")
        .unique()
        .join(canada, left_on="ps_suppkey", right_on="s_suppkey")
        .select("s_name", "s_address")
        .sort("s_name")
    )


def q21(t):
    li = t["lineitem"]
    multi = (
        li.group_by("l_orderkey")
        .agg(pl.col("l_suppkey").n_unique().alias("n"))
        .filter(pl.col("n") > 1)
        .join(li.filter(pl.col("l_receiptdate") > pl.col("l_commitdate")), on="l_orderkey")
    )
    return (
        multi.group_by("l_orderkey")
        .agg(pl.col("l_suppkey").n_unique().alias("n_late"))
        .join(multi, on="l_orderkey")
        .join(t["supplier"], left_on="l_suppkey", right_on="s_suppkey")
        .join(t["nation"], left_on="s_nationkey", right_on="n_nationkey")
        .join(t["orders"], left_on="l_orderkey", right_on="o_orderkey")
        .filter((pl.col("n_late") == 1) & (pl.col("n_name") == "SAUDI ARABIA") & (pl.col("o_orderstatus") == "F"))
        .group_by("s_name")
        .agg(pl.len().alias("numwait"))
        .sort(["numwait", "s_name"], descending=[True, False])
        .head(100)
    )


def q22(t):
    codes = ["13", "31", "23", "29", "30", "18", "17"]
    cust = (
        t["customer"]
        .with_columns(pl.col("c_phone").str.slice(0, 2).alias("cntrycode"))
        .filter(pl.col("cntrycode").is_in(codes))
        .select("c_acctbal", "c_custkey", "cntrycode")
    )
    avg = cust.filter(pl.col("c_acctbal") > 0.0).select(pl.col("c_acctbal").mean().alias("avg_acctbal"))
    return (
        cust.join(t["orders"], left_on="c_custkey", right_on="o_custkey", how="anti")
        .join(avg, how="cross")
        .filter(pl.col("c_acctbal") > pl.col("avg_acctbal"))
        .group_by("cntrycode")
        .agg(pl.col("c_acctbal").count().alias("numcust"), pl.col("c_acctbal").sum().alias("totacctbal"))
        .sort("cntrycode")
    )


QUERIES = {i: globals()[f"q{i}"] for i in range(1, 23)}
