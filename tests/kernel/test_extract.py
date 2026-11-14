"""``extract.write``: a dataset's result as one Parquet file, read under an allow list."""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq
import pytest

import iara as ia
from iara.kernel.session import KernelSession

BY_GROUP = "select grp, sum(amount) as total from sales group by grp"


@pytest.fixture()
def session(workspace: Path):
    cwd = os.getcwd()
    s = KernelSession(workspace)
    yield s
    os.chdir(cwd)


@pytest.fixture()
def out_dir(tmp_path: Path) -> Path:
    """A folder for extracts (the workspace is ``tmp_path`` itself)."""
    (tmp_path / "out").mkdir()
    return tmp_path / "out"


def extract(
    session: KernelSession,
    path: Path | str,
    query: str = BY_GROUP,
    allow: list[str] | None = None,
    max_bytes: int = 1 << 20,
    events: list[tuple[str, dict[str, Any]]] | None = None,
) -> Any:
    params = {"query": query, "path": str(path), "allow": ["demo.main.sales"] if allow is None else allow, "max_bytes": max_bytes}
    sink = [] if events is None else events
    return session.handlers()["extract.write"](params, lambda event, data: sink.append((event, data)))


def test_writes_one_zstd_parquet_file(session: KernelSession, tmp_path: Path):
    out = tmp_path / "extracts" / "by_group.parquet"
    result = extract(session, out)
    assert result["rows"] == 7
    assert result["bytes"] == out.stat().st_size
    assert result["columns"] == [{"name": "grp", "type": "int64"}, {"name": "total", "type": "double"}]
    assert result["sources"] == ["demo.main.sales"]
    assert [p.name for p in out.parent.iterdir()] == ["by_group.parquet"]
    meta = pq.ParquetFile(out).metadata
    assert meta.num_rows == 7 and meta.row_group(0).column(0).compression == "ZSTD"
    assert pq.read_table(out).num_rows == 7


def test_an_empty_result_is_still_a_file_with_its_columns(session: KernelSession, out_dir: Path):
    out = out_dir / "none.parquet"
    result = extract(session, out, "select id, amount from sales where id < 0")
    assert result["rows"] == 0 and [c["name"] for c in result["columns"]] == ["id", "amount"]
    assert pq.read_table(out).num_rows == 0


def test_sources_are_every_table_the_query_read(session: KernelSession, out_dir: Path):
    query = "select r.region, count(*) as n from sales s join regions r on s.grp = r.grp group by r.region"
    result = extract(session, out_dir / "x.parquet", query, allow=["demo"])
    assert result["sources"] == ["demo.main.regions", "demo.main.sales"]


def test_an_allow_list_that_does_not_cover_the_table_fails(session: KernelSession, out_dir: Path):
    out = out_dir / "x.parquet"
    with pytest.raises(Exception, match="no read grant"):
        extract(session, out, allow=["demo.main.regions"])
    assert not out.exists()


def test_over_the_limit_fails_and_leaves_no_file(session: KernelSession, out_dir: Path):
    out = out_dir / "x.parquet"
    with pytest.raises(ValueError, match=r"MB limit: aggregate the dataset or make it live"):
        extract(session, out, max_bytes=100)
    assert list(out_dir.iterdir()) == []
    # a refresh that fails keeps the extract it would have replaced
    out.write_bytes(b"old")
    with pytest.raises(ValueError):
        extract(session, out, max_bytes=100)
    assert out.read_bytes() == b"old"


@pytest.mark.parametrize(
    ("query", "message"),
    [
        ("select * from read_parquet('data/sales.parquet')", "reading files directly is not allowed"),
        ("select * from 'data/regions.csv'", "reading files directly is not allowed"),
        ("create table copy_of_sales as select * from sales", "only queries are allowed here"),
    ],
)
def test_files_and_writes_are_refused_even_with_a_full_grant(session: KernelSession, out_dir: Path, query: str, message: str):
    out = out_dir / "x.parquet"
    with pytest.raises(Exception, match=message):
        extract(session, out, query, allow=["*"])
    assert not out.exists()


def test_the_run_is_in_the_history(session: KernelSession, out_dir: Path):
    events: list[tuple[str, dict[str, Any]]] = []
    extract(session, out_dir / "x.parquet", events=events)
    with pytest.raises(ValueError):
        extract(session, out_dir / "y.parquet", max_bytes=100, events=events)
    done, failed = [data for name, data in events if name == "history"]
    assert done["source"] == "extract" and done["rows"] == 7 and done["error"] is None
    assert "ValueError" in failed["error"]


def test_it_can_be_interrupted(session: KernelSession, out_dir: Path):
    exploding = "select a.id from sales a join sales b on a.grp = b.grp join sales c on b.grp = c.grp join sales d on c.grp = d.grp"

    def interrupt_soon() -> None:
        deadline = time.monotonic() + 10
        while not session.interruptor.busy and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.2)
        session.interruptor.interrupt()

    threading.Thread(target=interrupt_soon, daemon=True).start()
    out = out_dir / "x.parquet"
    t0 = time.monotonic()
    with pytest.raises((ia.QueryCancelled, KeyboardInterrupt)):
        extract(session, out, exploding, max_bytes=1 << 40)
    assert time.monotonic() - t0 < 10
    assert list(out_dir.iterdir()) == []


# -- an s3:// destination, through a local S3 server (moto) -------------------

BUCKET = "extracts"


@pytest.fixture()
def s3(monkeypatch: pytest.MonkeyPatch):
    boto3 = pytest.importorskip("boto3")
    moto_server = pytest.importorskip("moto.server")
    for k, v in {"AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test", "AWS_REGION": "us-east-1"}.items():
        monkeypatch.setenv(k, v)
    server = moto_server.ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    url = f"http://{host}:{port}"
    client = boto3.client("s3", endpoint_url=url, region_name="us-east-1")
    client.create_bucket(Bucket=BUCKET)
    ia.set_storage_options(f"s3://{BUCKET}", {"endpoint": url, "allow_http": True})
    yield client
    ia.set_storage_options(f"s3://{BUCKET}", None)
    ia.storage.clear_object_stores()
    server.stop()


def test_writes_to_s3_and_a_result_over_the_limit_leaves_no_object(session: KernelSession, s3: Any):
    result = extract(session, f"s3://{BUCKET}/dash/by_group.parquet")
    head = s3.head_object(Bucket=BUCKET, Key="dash/by_group.parquet")
    assert result["rows"] == 7 and result["bytes"] == head["ContentLength"]

    with pytest.raises(ValueError, match="aggregate the dataset or make it live"):
        extract(session, f"s3://{BUCKET}/dash/big.parquet", max_bytes=100)
    keys = [o["Key"] for o in s3.list_objects_v2(Bucket=BUCKET).get("Contents", [])]
    assert keys == ["dash/by_group.parquet"]
