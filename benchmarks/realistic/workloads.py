"""DataFrame workloads modelled on day-to-day data work (not TPC-H queries).

Each workload takes an engine adapter ``E`` (Iara or Polars, same
Polars-style API) and returns a callable that runs it and returns a row count.
Datasets live on D: (see ``DATA``).
"""

from __future__ import annotations

import os

T = os.environ.get("REAL_TPCH", "D:/test_tpch_sf10")
H = os.environ.get("REAL_HITS", "D:/clickbench/hits.parquet")
R = os.environ.get("REAL_DIR", "D:/iara-real")
OUT = os.environ.get("REAL_OUT", "D:/iara-real/out")
ORDERS_CSV = os.environ.get("REAL_ORDERS_CSV", f"{R}/orders_sf10.csv")
LINEITEM_CSV = os.environ.get("REAL_LINEITEM_CSV", f"{R}/lineitem_sf10.csv")
HITS_NDJSON = os.environ.get("REAL_HITS_NDJSON", f"{R}/hits_1m.ndjson")
SMALL_FILES = os.environ.get("REAL_SMALL_FILES", f"{R}/lineitem_small/*.parquet")


def tpch(t: str) -> str:
    return f"{T}/{t}/{t}.parquet"


class Iara:
    name = "iara"

    def __init__(self) -> None:
        import iara
        from iara import functions as F

        self.m, self.F = iara, F
        self.col, self.lit, self.when, self.concat_str = F.col, F.lit, F.when, F.concat_str

    def len(self):
        return self.F.len()

    def scan_parquet(self, p):
        return self.m.scan_parquet(p)

    def scan_csv(self, p):
        return self.m.scan_csv(p)

    def scan_ndjson(self, p):
        return self.m.scan_ndjson(p)

    def read_parquet(self, p):
        return self.m.read_parquet(p)

    def collect(self, lf):
        return lf.collect()

    def sink(self, lf, path):
        lf.sink_parquet(path)

    def height(self, df):
        return df.height


class Polars:
    name = "polars"

    def __init__(self) -> None:
        import polars as pl

        self.m = pl
        self.col, self.lit, self.when, self.concat_str = pl.col, pl.lit, pl.when, pl.concat_str

    def len(self):
        return self.m.len()

    def scan_parquet(self, p):
        return self.m.scan_parquet(p)

    def scan_csv(self, p):
        return self.m.scan_csv(p, try_parse_dates=True)

    def scan_ndjson(self, p):
        return self.m.scan_ndjson(p)

    def read_parquet(self, p):
        return self.m.read_parquet(p)

    def collect(self, lf):
        return lf.collect(engine="streaming")

    def sink(self, lf, path):
        lf.sink_parquet(path)

    def height(self, df):
        return df.height


def _sink(E, lf, name):
    os.makedirs(OUT, exist_ok=True)
    path = f"{OUT}/{name}_{E.name}.parquet"
    if os.path.exists(path):
        os.remove(path)
    E.sink(lf, path)
    import pyarrow.parquet as pq

    rows = pq.ParquetFile(path).metadata.num_rows
    os.remove(path)  # outputs are large; the disk holds only one at a time
    return rows


# ---------------------------------------------------------------- ingestion
def csv_groupby(E):
    c = E.col
    lf = E.scan_csv(ORDERS_CSV).filter(c("o_orderstatus") == "F").group_by("o_orderpriority").agg(
        n=E.len(), total=c("o_totalprice").sum(), avg=c("o_totalprice").mean()
    )
    return lambda: E.height(E.collect(lf))


def csv_big_aggregate(E):
    c = E.col
    lf = E.scan_csv(LINEITEM_CSV).group_by("l_returnflag", "l_linestatus").agg(
        qty=c("l_quantity").sum(), price=c("l_extendedprice").sum(), disc=c("l_discount").mean(), n=E.len()
    )
    return lambda: E.height(E.collect(lf))


def csv_to_parquet(E):
    return lambda: _sink(E, E.scan_csv(ORDERS_CSV), "orders_from_csv")


def ndjson_groupby(E):
    c = E.col
    lf = E.scan_ndjson(HITS_NDJSON).group_by("SearchEngineID").agg(n=E.len(), users=c("UserID").n_unique())
    return lambda: E.height(E.collect(lf))


def many_small_files(E):
    c = E.col
    lf = E.scan_parquet(SMALL_FILES).group_by("l_shipmode").agg(
        rev=(c("l_extendedprice") * (1 - c("l_discount"))).sum(), n=E.len()
    )
    return lambda: E.height(E.collect(lf))


# ---------------------------------------------------------------- transform + write
def feature_engineering_sink(E):
    c = E.col
    lf = E.scan_parquet(tpch("lineitem")).with_columns(
        disc_price=c("l_extendedprice") * (1 - c("l_discount")),
        charge=c("l_extendedprice") * (1 - c("l_discount")) * (1 + c("l_tax")),
        ship_year=c("l_shipdate").dt.year(),
        ship_month=c("l_shipdate").dt.month(),
        ship_weekday=c("l_shipdate").dt.weekday(),
        late=c("l_receiptdate") > c("l_commitdate"),
        size=E.when(c("l_quantity") < 10).then(E.lit("small")).when(c("l_quantity") < 30).then(E.lit("medium")).otherwise(E.lit("large")),
        mode=c("l_shipmode").str.to_lowercase(),
        key=E.concat_str([c("l_returnflag"), c("l_linestatus")], separator="-"),
    )
    return lambda: _sink(E, lf, "lineitem_features")


def full_sort_sink(E):
    lf = E.scan_parquet(tpch("orders")).sort("o_custkey", "o_orderdate", descending=[False, True])
    return lambda: _sink(E, lf, "orders_sorted")


def to_pandas(E):
    lf = E.scan_parquet(tpch("orders"))
    return lambda: len(E.collect(lf).to_pandas())


# ---------------------------------------------------------------- windows
def top3_per_customer(E):
    c = E.col
    lf = (
        E.scan_parquet(tpch("orders"))
        .with_columns(r=c("o_totalprice").rank("ordinal", descending=True).over("o_custkey"))
        .filter(c("r") <= 3)
    )
    return lambda: E.height(E.collect(lf))


def sessionize(E):
    c = E.col
    gap = c("EventTime") - c("EventTime").shift(1).over("UserID", order_by="EventTime")
    lf = (
        E.scan_parquet(H)
        .select("UserID", "EventTime")
        .with_columns(new=(gap.is_null() | (gap > 1800)).cast(E.m.Int64 if E.name == "polars" else "int64"))
        .with_columns(session=c("new").cum_sum().over("UserID", order_by="EventTime"))
        .group_by("UserID")
        .agg(sessions=c("session").max(), hits=E.len())
    )
    return lambda: E.height(E.collect(lf))


def rolling_daily(E):
    c = E.col
    lf = (
        E.scan_parquet(H)
        .group_by("CounterID", "EventDate")
        .agg(n=E.len())
        .with_columns(avg7=c("n").rolling_mean(7).over("CounterID", order_by="EventDate"))
    )
    return lambda: E.height(E.collect(lf))


# ---------------------------------------------------------------- strings
def url_domains(E):
    c = E.col
    lf = (
        E.scan_parquet(H)
        .with_columns(domain=c("URL").str.extract(r"^https?://(?:www\.)?([^/]+)", 1))
        .filter(c("domain").is_not_null())
        .group_by("domain")
        .agg(n=E.len(), users=c("UserID").n_unique())
        .sort("n", descending=True)
        .limit(100)
    )
    return lambda: E.height(E.collect(lf))


def word_count(E):
    c = E.col
    lf = (
        E.scan_parquet(tpch("lineitem"))
        .select(word=c("l_comment").str.split(" "))
        .explode("word")
        .group_by("word")
        .agg(n=E.len())
        .sort("n", descending=True)
        .limit(50)
    )
    return lambda: E.height(E.collect(lf))


def search_phrase_contains(E):
    c = E.col
    lf = E.scan_parquet(H).filter(c("Title").str.contains("google", literal=True) if E.name == "polars" else c("Title").str.contains("google")).select(
        E.len()
    )
    return lambda: E.height(E.collect(lf))


def string_key_join(E):
    c = E.col
    o = E.scan_parquet(tpch("orders")).with_columns(
        cname=E.concat_str([E.lit("Customer#"), c("o_custkey").cast(E.m.String if E.name == "polars" else "string").str.zfill(9)])
    )
    lf = o.join(E.scan_parquet(tpch("customer")), left_on="cname", right_on="c_name").group_by("c_mktsegment").agg(
        total=c("o_totalprice").sum(), n=E.len()
    )
    return lambda: E.height(E.collect(lf))


# ---------------------------------------------------------------- dedupe, wide rows
def dedupe_pairs(E):
    lf = E.scan_parquet(H).select("UserID", "URL").unique().select(E.len())
    return lambda: E.height(E.collect(lf))


def wide_filter(E):
    c = E.col
    lf = E.scan_parquet(H).filter((c("CounterID") == 62) & (c("IsRefresh") == 0) & (c("DontCountHits") == 0))
    return lambda: E.height(E.collect(lf))


def conditional_aggs(E):
    c = E.col
    aggs = {f"os_{i}": (c("OS") == i).cast(E.m.Int64 if E.name == "polars" else "int64").sum() for i in range(8)}
    lf = E.scan_parquet(H).group_by("CounterID").agg(n=E.len(), **aggs)
    return lambda: E.height(E.collect(lf))


# ---------------------------------------------------------------- interactive (eager)
def eager_session(E):
    """A notebook: load once, then several quick questions on the frame."""
    c = E.col

    def run():
        df = E.read_parquet(tpch("orders"))
        total = 0
        for q in (
            lambda d: d.filter(c("o_orderstatus") == "O"),
            lambda d: d.group_by("o_orderpriority").agg(n=E.len()),
            lambda d: d.sort("o_totalprice", descending=True).head(20),
            lambda d: d.with_columns(y=c("o_orderdate").dt.year()).group_by("y").agg(s=c("o_totalprice").sum()),
            lambda d: d.filter(c("o_comment").str.contains("special")).select(c("o_custkey").n_unique()),
        ):
            total += q(df).height
        return total

    return run


WORKLOADS = {
    f.__name__: f
    for f in [
        csv_groupby,
        csv_big_aggregate,
        csv_to_parquet,
        ndjson_groupby,
        many_small_files,
        feature_engineering_sink,
        full_sort_sink,
        to_pandas,
        top3_per_customer,
        sessionize,
        rolling_daily,
        url_domains,
        word_count,
        search_phrase_contains,
        string_key_join,
        dedupe_pairs,
        wide_filter,
        conditional_aggs,
        eager_session,
    ]
}
ENGINES = {"iara": Iara, "polars": Polars}
