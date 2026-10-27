"""The teste_iara notebook pipelines, run on Iara and Polars against the same
parquet files on S3/R2 (no Iara-managed tables involved).

The Iara and Polars APIs line up for these pipelines, so one source text serves
both: F is iara.functions or polars.

    uv run --env-file docker/studio-default.env python benchmarks/teste_iara_vs_polars.py [--runs 3]

Credentials come from S3_KEY_ID / S3_SECRET_KEY, endpoint and bucket from
IARA_STORAGE_ENDPOINT / IARA_BUCKET; nothing is printed.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time

TABLES = ["customer", "orders", "lineitem", "part", "partsupp", "supplier", "nation", "region"]
PIPELINES = ["s1", "s2", "vendas_por_peca"]
ENGINES = ["iara", "polars", "polars-streaming"]


def _env() -> tuple[str, dict[str, str]]:
    bucket = os.environ.get("IARA_BUCKET", "workhouse-base")
    # Outside a cluster the keys come from S3_KEY_ID / S3_SECRET_KEY / IARA_STORAGE_ENDPOINT;
    # on a cluster the kernel already has AWS_* pointing at the local S3 proxy.
    os.environ.setdefault("AWS_ACCESS_KEY_ID", os.environ.get("S3_KEY_ID", ""))
    os.environ.setdefault("AWS_SECRET_ACCESS_KEY", os.environ.get("S3_SECRET_KEY", ""))
    os.environ.setdefault("AWS_ENDPOINT_URL", os.environ.get("IARA_STORAGE_ENDPOINT", ""))
    os.environ.setdefault("AWS_REGION", "auto")
    endpoint = os.environ["AWS_ENDPOINT_URL"]
    return bucket, {
        "aws_access_key_id": os.environ["AWS_ACCESS_KEY_ID"],
        "aws_secret_access_key": os.environ["AWS_SECRET_ACCESS_KEY"],
        "aws_endpoint_url": endpoint,
        "aws_region": os.environ["AWS_REGION"],
        "aws_allow_http": str(endpoint.startswith("http://")).lower(),
    }


def build(engine: str):
    bucket, polars_opts = _env()
    if engine == "iara":
        import iara
        import iara.functions as F

        scan = iara.scan_parquet
    else:
        import polars as F

        def scan(path):
            return F.scan_parquet(path, storage_options=polars_opts)

    t = {n: scan(f"s3://{bucket}/warehouse/{n}/*.parquet") for n in TABLES}
    customer, orders, lineitem, part = t["customer"], t["orders"], t["lineitem"], t["part"]
    supplier, nation, region = t["supplier"], t["nation"], t["region"]

    pipeline_s1 = (
        customer.filter(
            (F.col("c_mktsegment") == "AUTOMOBILE")
            & (F.col("c_acctbal") > 5000)
            & F.col("c_comment").str.contains(r"(?i)\b(unusual|special|express|requests?|complaint|account)\b")
        )
        .join(nation, left_on="c_nationkey", right_on="n_nationkey")
        .join(region, left_on="n_regionkey", right_on="r_regionkey")
        .join(orders, left_on="c_custkey", right_on="o_custkey")
        .join(lineitem, left_on="o_orderkey", right_on="l_orderkey")
        .join(part, left_on="l_partkey", right_on="p_partkey")
        .join(supplier, left_on="l_suppkey", right_on="s_suppkey")
        .with_columns(
            issue_phrase=F.col("c_comment").str.extract(r"([a-z]+(?: [a-z]+)* (?:account|request|deposit|package))", 1),
            material_finish=F.col("p_type").str.extract(
                r"^(?:PROMO|STANDARD|SMALL|MEDIUM|LARGE)\s+([A-Z]+)\s+([A-Z]+)$", 1
            ),
            alloy_metal=F.col("p_type").str.extract(r"^(?:PROMO|STANDARD|SMALL|MEDIUM|LARGE)\s+([A-Z]+)\s+([A-Z]+)$", 2),
            supplier_sentiment=F.col("s_comment").str.extract(r"Customer ([a-zA-Z]+)", 1),
            redacted_phone=F.col("c_phone").str.replace_all(r"(\d{2})-(\d{3})-(\d{3})-(\d{4})", "$1-$2-XXX-$4"),
        )
        .group_by("r_name", "n_name", "alloy_metal", "material_finish")
        .agg(
            affected_customers=F.col("c_custkey").n_unique(),
            total_orders_audited=F.col("o_orderkey").n_unique(),
            total_parts_delivered=F.col("l_quantity").sum(),
            total_exposure_usd=F.col("l_extendedprice").sum(),
        )
        .sort("total_exposure_usd", descending=True)
    )

    cust_nation = nation.select(n_nationkey_cust=F.col("n_nationkey"), customer_nation=F.col("n_name"))
    supp_nation = nation.select(n_nationkey_supp=F.col("n_nationkey"), supplier_nation=F.col("n_name"))

    pipeline_s2 = (
        lineitem.filter(
            F.col("l_shipinstruct").str.contains(r"(?i)\b(deliver in person|collect cod|take back return)\b")
            & (F.col("l_discount") > 0.04)
        )
        .join(orders, left_on="l_orderkey", right_on="o_orderkey")
        .filter(F.col("o_comment").str.contains(r"(?i)\b(carefully|express|urgent|special|packages)\b"))
        .join(customer, left_on="o_custkey", right_on="c_custkey")
        .join(cust_nation, left_on="c_nationkey", right_on="n_nationkey_cust")
        .join(supplier, left_on="l_suppkey", right_on="s_suppkey")
        .join(supp_nation, left_on="s_nationkey", right_on="n_nationkey_supp")
        .filter(F.col("customer_nation") != F.col("supplier_nation"))
        .with_columns(
            cargo_instruction=F.col("l_comment").str.extract(
                r"([a-z]+(?: [a-z]+)* (?:packages|requests|instructions|deposits))", 1
            ),
            supplier_flag=F.col("s_comment").str.extract(r"(?i)\b(complaints?|recommends?|special requests?)\b", 1),
            net_line_revenue=F.col("l_extendedprice") * (1 - F.col("l_discount")),
        )
        .group_by("supplier_nation", "customer_nation", "l_shipmode")
        .agg(
            cross_border_shipments=F.len(),
            unique_orders=F.col("l_orderkey").n_unique(),
            total_net_revenue=F.col("net_line_revenue").sum(),
            avg_discount=F.col("l_discount").mean(),
        )
        .sort("total_net_revenue", descending=True)
    )

    vendas_por_peca = (
        lineitem.group_by("l_partkey")
        .agg(unidades_vendidas=F.col("l_quantity").sum())
        .join(part.select(F.col("p_partkey"), F.col("p_name")), left_on="l_partkey", right_on="p_partkey")
        .select(F.col("p_name"), F.col("unidades_vendidas"))
        .sort("unidades_vendidas", descending=True)
    )
    return {"s1": pipeline_s1, "s2": pipeline_s2, "vendas_por_peca": vendas_por_peca}


def child(engine: str, name: str, runs: int) -> None:
    lf = build(engine)[name]
    times, shape = [], None
    for _ in range(runs):
        t0 = time.perf_counter()
        df = lf.collect(engine="streaming") if engine == "polars-streaming" else lf.collect()
        times.append(time.perf_counter() - t0)
        shape = (df.height, df.width)
    print("@@bench " + json.dumps({"engine": engine, "pipeline": name, "times": times, "shape": shape}), flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--engines", default=",".join(ENGINES))
    ap.add_argument("--pipelines", default=",".join(PIPELINES))
    ap.add_argument("--child", nargs=2, metavar=("ENGINE", "PIPELINE"))
    a = ap.parse_args()
    if a.child:
        return child(*a.child, a.runs)

    rows = []
    for name in a.pipelines.split(","):
        for engine in a.engines.split(","):
            p = subprocess.run(
                [sys.executable, __file__, "--child", engine, name, "--runs", str(a.runs)],
                capture_output=True,
                text=True,
                timeout=1800,
            )
            line = next((l for l in p.stdout.splitlines() if l.startswith("@@bench ")), None)
            if line is None:
                print(f"{engine:18s} {name:16s} FAILED\n{p.stderr[-1500:]}")
                continue
            r = json.loads(line[8:])
            rows.append(r)
            ts = " ".join(f"{t:7.2f}" for t in r["times"])
            print(f"{engine:18s} {name:16s} runs[s]: {ts}   best {min(r['times']):6.2f}  rows,cols={r['shape']}", flush=True)
    print("\nbest of runs, seconds")
    print(f"{'pipeline':18s}" + "".join(f"{e:>18s}" for e in a.engines.split(",")))
    for name in a.pipelines.split(","):
        cells = {r["engine"]: min(r["times"]) for r in rows if r["pipeline"] == name}
        print(f"{name:18s}" + "".join(f"{cells.get(e, float('nan')):18.2f}" for e in a.engines.split(",")))


if __name__ == "__main__":
    main()
