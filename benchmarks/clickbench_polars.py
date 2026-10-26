"""The 43 ClickBench queries written with the native Polars lazy API, so Polars is
benchmarked through its DataFrame frontend rather than its SQL one (which lacks
regexp_replace and date_trunc). Each query is a direct translation of the SQL in
clickbench_queries.py: same filters, group keys, aggregates, order and limit."""

from __future__ import annotations

from datetime import date

import polars as pl

c = pl.col
JULY = c("EventDate").is_between(date(2013, 7, 1), date(2013, 7, 31))


def _top(lf: pl.LazyFrame, by: str, n: int = 10, offset: int = 0) -> pl.LazyFrame:
    return lf.sort(by, descending=True).slice(offset, n)


QUERIES = {
    0: lambda h: h.select(pl.len()),
    1: lambda h: h.filter(c("AdvEngineID") != 0).select(pl.len()),
    2: lambda h: h.select(c("AdvEngineID").sum(), pl.len(), c("ResolutionWidth").mean()),
    3: lambda h: h.select(c("UserID").mean()),
    4: lambda h: h.select(c("UserID").n_unique()),
    5: lambda h: h.select(c("SearchPhrase").n_unique()),
    6: lambda h: h.select(c("EventDate").min().alias("min"), c("EventDate").max().alias("max")),
    7: lambda h: h.filter(c("AdvEngineID") != 0).group_by("AdvEngineID").agg(pl.len().alias("c")).sort("c", descending=True),
    8: lambda h: _top(h.group_by("RegionID").agg(c("UserID").n_unique().alias("u")), "u"),
    9: lambda h: _top(
        h.group_by("RegionID").agg(
            c("AdvEngineID").sum(), pl.len().alias("c"), c("ResolutionWidth").mean(), c("UserID").n_unique().alias("u")
        ),
        "c",
    ),
    10: lambda h: _top(
        h.filter(c("MobilePhoneModel") != "").group_by("MobilePhoneModel").agg(c("UserID").n_unique().alias("u")), "u"
    ),
    11: lambda h: _top(
        h.filter(c("MobilePhoneModel") != "")
        .group_by("MobilePhone", "MobilePhoneModel")
        .agg(c("UserID").n_unique().alias("u")),
        "u",
    ),
    12: lambda h: _top(h.filter(c("SearchPhrase") != "").group_by("SearchPhrase").agg(pl.len().alias("c")), "c"),
    13: lambda h: _top(
        h.filter(c("SearchPhrase") != "").group_by("SearchPhrase").agg(c("UserID").n_unique().alias("u")), "u"
    ),
    14: lambda h: _top(
        h.filter(c("SearchPhrase") != "").group_by("SearchEngineID", "SearchPhrase").agg(pl.len().alias("c")), "c"
    ),
    15: lambda h: _top(h.group_by("UserID").agg(pl.len().alias("c")), "c"),
    16: lambda h: _top(h.group_by("UserID", "SearchPhrase").agg(pl.len().alias("c")), "c"),
    17: lambda h: h.group_by("UserID", "SearchPhrase").agg(pl.len()).head(10),
    18: lambda h: _top(
        h.group_by("UserID", c("EventTime").dt.minute().alias("m"), "SearchPhrase").agg(pl.len().alias("c")), "c"
    ),
    19: lambda h: h.filter(c("UserID") == 435090932899640449).select("UserID"),
    20: lambda h: h.filter(c("URL").str.contains("google", literal=True)).select(pl.len()),
    21: lambda h: _top(
        h.filter(c("URL").str.contains("google", literal=True) & (c("SearchPhrase") != ""))
        .group_by("SearchPhrase")
        .agg(c("URL").min(), pl.len().alias("c")),
        "c",
    ),
    22: lambda h: _top(
        h.filter(
            c("Title").str.contains("Google", literal=True)
            & ~c("URL").str.contains(".google.", literal=True)
            & (c("SearchPhrase") != "")
        )
        .group_by("SearchPhrase")
        .agg(c("URL").min(), c("Title").min(), pl.len().alias("c"), c("UserID").n_unique().alias("u")),
        "c",
    ),
    23: lambda h: h.filter(c("URL").str.contains("google", literal=True)).sort("EventTime").head(10),
    24: lambda h: h.filter(c("SearchPhrase") != "").sort("EventTime").select("SearchPhrase").head(10),
    25: lambda h: h.filter(c("SearchPhrase") != "").select("SearchPhrase").sort("SearchPhrase").head(10),
    26: lambda h: h.filter(c("SearchPhrase") != "").sort("EventTime", "SearchPhrase").select("SearchPhrase").head(10),
    27: lambda h: h.filter(c("URL") != "")
    .group_by("CounterID")
    .agg(c("URL").str.len_bytes().mean().alias("l"), pl.len().alias("c"))
    .filter(c("c") > 100000)
    .sort("l", descending=True)
    .head(25),
    28: lambda h: h.filter(c("Referer") != "")
    .group_by(c("Referer").str.replace(r"^https?://(?:www\.)?([^/]+)/.*$", "${1}").alias("k"))
    .agg(c("Referer").str.len_bytes().mean().alias("l"), pl.len().alias("c"), c("Referer").min())
    .filter(c("c") > 100000)
    .sort("l", descending=True)
    .head(25),
    29: lambda h: h.select([(c("ResolutionWidth") + i).sum().alias(f"s{i}") for i in range(90)]),
    30: lambda h: _top(
        h.filter(c("SearchPhrase") != "")
        .group_by("SearchEngineID", "ClientIP")
        .agg(pl.len().alias("c"), c("IsRefresh").sum(), c("ResolutionWidth").mean()),
        "c",
    ),
    31: lambda h: _top(
        h.filter(c("SearchPhrase") != "")
        .group_by("WatchID", "ClientIP")
        .agg(pl.len().alias("c"), c("IsRefresh").sum(), c("ResolutionWidth").mean()),
        "c",
    ),
    32: lambda h: _top(
        h.group_by("WatchID", "ClientIP").agg(pl.len().alias("c"), c("IsRefresh").sum(), c("ResolutionWidth").mean()),
        "c",
    ),
    33: lambda h: _top(h.group_by("URL").agg(pl.len().alias("c")), "c"),
    34: lambda h: _top(h.group_by("URL").agg(pl.len().alias("c")), "c").select(pl.lit(1).alias("one"), "URL", "c"),
    35: lambda h: _top(
        h.group_by(
            "ClientIP",
            (c("ClientIP") - 1).alias("ip1"),
            (c("ClientIP") - 2).alias("ip2"),
            (c("ClientIP") - 3).alias("ip3"),
        ).agg(pl.len().alias("c")),
        "c",
    ),
    36: lambda h: _top(
        h.filter((c("CounterID") == 62) & JULY & (c("DontCountHits") == 0) & (c("IsRefresh") == 0) & (c("URL") != ""))
        .group_by("URL")
        .agg(pl.len().alias("PageViews")),
        "PageViews",
    ),
    37: lambda h: _top(
        h.filter((c("CounterID") == 62) & JULY & (c("DontCountHits") == 0) & (c("IsRefresh") == 0) & (c("Title") != ""))
        .group_by("Title")
        .agg(pl.len().alias("PageViews")),
        "PageViews",
    ),
    38: lambda h: _top(
        h.filter(
            (c("CounterID") == 62) & JULY & (c("IsRefresh") == 0) & (c("IsLink") != 0) & (c("IsDownload") == 0)
        )
        .group_by("URL")
        .agg(pl.len().alias("PageViews")),
        "PageViews",
        offset=1000,
    ),
    39: lambda h: _top(
        h.filter((c("CounterID") == 62) & JULY & (c("IsRefresh") == 0))
        .group_by(
            "TraficSourceID",
            "SearchEngineID",
            "AdvEngineID",
            pl.when((c("SearchEngineID") == 0) & (c("AdvEngineID") == 0)).then(c("Referer")).otherwise(pl.lit("")).alias("Src"),
            c("URL").alias("Dst"),
        )
        .agg(pl.len().alias("PageViews")),
        "PageViews",
        offset=1000,
    ),
    40: lambda h: _top(
        h.filter(
            (c("CounterID") == 62)
            & JULY
            & (c("IsRefresh") == 0)
            & c("TraficSourceID").is_in([-1, 6])
            & (c("RefererHash") == 3594120000172545465)
        )
        .group_by("URLHash", "EventDate")
        .agg(pl.len().alias("PageViews")),
        "PageViews",
        offset=100,
    ),
    41: lambda h: _top(
        h.filter(
            (c("CounterID") == 62)
            & JULY
            & (c("IsRefresh") == 0)
            & (c("DontCountHits") == 0)
            & (c("URLHash") == 2868770270353813622)
        )
        .group_by("WindowClientWidth", "WindowClientHeight")
        .agg(pl.len().alias("PageViews")),
        "PageViews",
        offset=10000,
    ),
    42: lambda h: h.filter(
        (c("CounterID") == 62)
        & c("EventDate").is_between(date(2013, 7, 14), date(2013, 7, 15))
        & (c("IsRefresh") == 0)
        & (c("DontCountHits") == 0)
    )
    .group_by(c("EventTime").dt.truncate("1m").alias("M"))
    .agg(pl.len().alias("PageViews"))
    .sort("M")
    .slice(1000, 10),
}
