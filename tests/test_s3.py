"""Reading and writing S3 through a local S3 server (moto): results over
``s3://`` URLs must match the same files read locally."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pyarrow as pa
import pytest

import workhouse as wh
from workhouse import functions as F
from workhouse.kernel import catalog
from workhouse.workspaces import parse_config

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "benchmarks"))
from compare import diff  # noqa: E402
from tpch_queries import QUERIES, TABLES  # noqa: E402

boto3 = pytest.importorskip("boto3")
moto_server = pytest.importorskip("moto.server")

BUCKET = "wh-test"


@pytest.fixture(scope="module")
def endpoint():
    """A local S3 server; fake credentials come from the environment."""
    mp = pytest.MonkeyPatch()
    for k, v in {"AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test", "AWS_REGION": "us-east-1"}.items():
        mp.setenv(k, v)
    server = moto_server.ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    url = f"http://{host}:{port}"
    client(url).create_bucket(Bucket=BUCKET)
    wh.set_storage_options(f"s3://{BUCKET}", {"endpoint": url, "allow_http": True})
    yield url
    wh.set_storage_options(f"s3://{BUCKET}", None)
    wh.storage.clear_object_stores()
    server.stop()
    mp.undo()


def client(endpoint: str):
    return boto3.client("s3", endpoint_url=endpoint, region_name="us-east-1")


def upload_dir(endpoint: str, local: Path, prefix: str) -> None:
    s3 = client(endpoint)
    for f in sorted(local.rglob("*")):
        if f.is_file():
            s3.upload_file(str(f), BUCKET, f"{prefix}/{f.relative_to(local).as_posix()}")


@pytest.fixture(scope="module")
def tpch(tmp_path_factory, endpoint) -> Path:
    """TPC-H SF0.01 with small row groups, locally and under s3://wh-test/tpch/."""
    duckdb = pytest.importorskip("duckdb")
    out = tmp_path_factory.mktemp("tpch")
    con = duckdb.connect()
    con.execute("INSTALL tpch; LOAD tpch; CALL dbgen(sf=0.01)")
    for t in TABLES:
        cols = con.execute(f"DESCRIBE {t}").fetchall()
        sel = ", ".join(f"CAST({c} AS DOUBLE) AS {c}" if typ.startswith("DECIMAL") else c for c, typ, *_ in cols)
        (out / t).mkdir()
        path = (out / t / "part-0.parquet").as_posix()
        con.execute(f"COPY (SELECT {sel} FROM {t}) TO '{path}' (FORMAT PARQUET, ROW_GROUP_SIZE 2000)")
    con.close()
    upload_dir(endpoint, out, "tpch")
    return out


def contexts(local: Path) -> tuple[wh.SessionContext, wh.SessionContext]:
    loc, rem = wh.SessionContext(), wh.SessionContext()
    for t in TABLES:
        loc.register_parquet(t, str(local / t))
        rem.register_parquet(t, f"s3://{BUCKET}/tpch/{t}/")
    return loc, rem


@pytest.mark.parametrize("q", sorted(QUERIES))
def test_tpch_over_s3_matches_local(tpch: Path, q: int) -> None:
    loc, rem = contexts(tpch)
    expected = loc.sql(QUERIES[q]).collect().to_arrow()
    got = rem.sql(QUERIES[q]).collect().to_arrow()
    assert diff(got, expected) is None


def test_listing_and_globs(tpch: Path) -> None:
    files = wh.list_files(f"s3://{BUCKET}/tpch/")
    assert len(files) == len(TABLES) and all(size > 0 for _, size in files)
    one = wh.list_files(f"s3://{BUCKET}/tpch/*/part-0.parquet")
    assert [n for n, _ in one] == sorted(n for n, _ in files)
    n = wh.sql(f"select count(*) from read_parquet('s3://{BUCKET}/tpch/nation/*.parquet')").collect().item()
    assert n == 25


def test_write_and_read_back(endpoint: str) -> None:
    import numpy as np

    rows = 3_000_000  # ~24 MB uncompressed: more than one 16 MiB part
    df = wh.from_arrow(pa.table({"i": np.arange(rows), "x": np.random.default_rng(1).random(rows)}))
    df.write_parquet(f"s3://{BUCKET}/out/big.parquet", compression="none")
    back = wh.scan_parquet(f"s3://{BUCKET}/out/big.parquet").select(F.col("i").sum().alias("s")).collect().item()
    assert back == rows * (rows - 1) // 2
    small = wh.from_dict({"a": [1, 2, 3], "b": ["x", "y", "z"]})
    small.write_csv(f"s3://{BUCKET}/out/small.csv")
    assert wh.read_csv(f"s3://{BUCKET}/out/small.csv").to_arrow().column("b").to_pylist() == ["x", "y", "z"]


def test_named_storage_options_in_sql(tpch: Path, endpoint: str) -> None:
    # a prefix without defaults: the options come with the query
    other = "wh-other"
    client(endpoint).create_bucket(Bucket=other)
    client(endpoint).upload_file(str(tpch / "region" / "part-0.parquet"), other, "region.parquet")
    q = f"select count(*) from read_parquet('s3://{other}/region.parquet', endpoint => '{endpoint}', allow_http => true)"
    assert wh.sql(q).collect().item() == 5
    lf = wh.scan_parquet(f"s3://{other}/region.parquet", storage_options={"endpoint": endpoint, "allow_http": True})
    assert lf.collect().height == 5


def test_missing_objects_raise_storage_error(endpoint: str) -> None:
    with pytest.raises(wh.StorageError, match="not found"):
        wh.scan_parquet(f"s3://{BUCKET}/nope/x.parquet")
    with pytest.raises(wh.WorkhouseError):
        wh.scan_parquet(f"s3://{BUCKET}/nope/")


def test_workspace_with_s3_tables(tmp_path: Path, tpch: Path, endpoint: str) -> None:
    text = f"""
[workspace]
name = "cloud"

[tables.nation]
path = "s3://{BUCKET}/tpch/nation/"

[tables.ghost]
path = "s3://{BUCKET}/does/not/exist/"

[storage."s3://{BUCKET}"]
endpoint = "{endpoint}"
allow_http = true
"""
    ws = parse_config(text, tmp_path)
    assert [t.path for t in ws.tables] == [f"s3://{BUCKET}/tpch/nation/", f"s3://{BUCKET}/does/not/exist/"]
    # lazy registration: the broken table does not break the session
    assert ws.sql("select count(*) from nation").collect().item() == 25
    with pytest.raises(wh.WorkhouseError):
        ws.sql("select * from ghost").collect()
    info = catalog.table_info(ws, "nation")
    assert info["path"] == f"s3://{BUCKET}/tpch/nation/" and info["files"] == 1 and info["bytes"] > 0
    stats = {s["column"]: s for s in info["stats"]}
    assert stats["n_nationkey"]["min"] == 0 and stats["n_nationkey"]["max"] == 24
    assert "nation" in catalog.schemas(ws) and "ghost" not in catalog.schemas(ws)


def test_credentials_are_refused_in_workhouse_toml(tmp_path: Path) -> None:
    text = """
[storage."s3://b"]
region = "us-east-1"
secret_access_key = "nope"
"""
    with pytest.raises(ValueError, match="credentials"):
        parse_config(text, tmp_path)


def delta(before: dict[str, int], after: dict[str, int]) -> dict[str, int]:
    return {k: after[k] - before[k] for k in after}


NO_REQUESTS = {"list": 0, "head": 0, "get": 0, "bytes": 0}


def test_requests_are_counted_and_remembered(tpch: Path) -> None:
    """Object stores bill per request, a LIST dearest: a table object over files
    already seen asks for neither their listing nor their footers again."""
    wh.storage.clear_object_stores()  # a cold start
    url = f"s3://{BUCKET}/tpch/orders/"
    start = wh.storage.storage_requests()
    assert set(start) == {"list", "head", "get", "bytes"}
    wh.SessionContext().register_parquet("orders", url)
    first = delta(start, wh.storage.storage_requests())
    assert first["list"] == 1 and first["get"] >= 1 and first["bytes"] > 0  # one LIST, a footer per file

    mark = wh.storage.storage_requests()
    ctx = wh.SessionContext()
    ctx.register_parquet("orders", url)
    assert delta(mark, wh.storage.storage_requests()) == NO_REQUESTS

    # count(*) is answered from the footers
    df, prof = ctx.sql("select count(*) from orders").profile()
    assert df.to_arrow().column(0)[0].as_py() == 15_000
    assert prof["requests"] == NO_REQUESTS

    # a scan reads data, and its profile says how many requests that took
    _, prof = ctx.sql("select sum(o_totalprice) from orders").profile()
    assert prof["requests"]["list"] == 0 and prof["requests"]["get"] >= 1 and prof["requests"]["bytes"] > 0
    assert delta(mark, wh.storage.storage_requests()) == prof["requests"]


def test_writes_drop_cached_listings(endpoint: str) -> None:
    one = wh.from_dict({"a": [1, 2, 3]})
    one.write_parquet(f"s3://{BUCKET}/cache/a.parquet")
    q = f"select count(*) from read_parquet('s3://{BUCKET}/cache/*.parquet')"
    assert wh.sql(q).collect().item() == 3
    one.write_parquet(f"s3://{BUCKET}/cache/b.parquet")  # listed again at once: our own writes clear the cache
    assert wh.sql(q).collect().item() == 6
