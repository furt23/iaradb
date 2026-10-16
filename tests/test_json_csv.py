"""JSON / NDJSON IO and the CSV read options, compared with DuckDB and Polars.

Needs the extension rebuilt (``read_ndjson`` and the CSV option kwargs are new)."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa
import pytest

import iara as ia
from iara.workspaces import parse_config

sys.path.insert(0, os.path.dirname(__file__))
from compare import diff  # noqa: E402


def ddb(query: str) -> pa.Table:
    return duckdb.connect().execute(query).fetch_arrow_table()


def write_ndjson(path: Path, rows: list[dict[str, Any]]) -> str:
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    return str(path)


ROWS = [
    {"id": 1, "name": "Zoë", "score": 1.5, "ok": True},
    {"id": 2, "name": "日本語 ☃", "score": None, "ok": False},
    {"id": 3, "name": None, "score": 3.0, "ok": None},
    {"id": 4, "name": 'quote " and \\ and \n newline', "score": -0.25, "ok": True},
    {"id": 5, "name": "", "score": 1e10, "ok": False},
]


def test_read_ndjson_matches_duckdb(tmp_path: Path) -> None:
    p = write_ndjson(tmp_path / "a.ndjson", ROWS)
    got = ia.read_ndjson(p).sort("id").to_arrow()
    want = ddb(f"select * from read_json('{p}', format='newline_delimited') order by id")
    assert diff(got, want) is None
    assert [str(f.type) for f in got.schema] == ["int64", "string", "double", "bool"]


def test_sql_read_json_and_from_path(tmp_path: Path) -> None:
    p = write_ndjson(tmp_path / "a.json", ROWS)
    ctx = ia.SessionContext()
    for q in (f"select * from read_json('{p}')", f"select * from read_ndjson('{p}')", f"select * from '{p}'"):
        assert diff(ctx.sql(q + " order by id").collect().to_arrow(), ddb(q + " order by id")) is None


def test_scan_json_reads_arrays_and_ndjson(tmp_path: Path) -> None:
    arr = tmp_path / "arr.json"
    arr.write_text(json.dumps(ROWS, indent=2), encoding="utf-8")
    nd = write_ndjson(tmp_path / "nd.ndjson", ROWS)
    a = ia.read_json(str(arr)).sort("id").to_arrow()
    b = ia.read_ndjson(nd).sort("id").to_arrow()
    assert diff(a, b) is None
    want = ddb(f"select * from read_json('{arr}', format='array') order by id")
    assert diff(a, want) is None


def test_nested_values_are_text(tmp_path: Path) -> None:
    p = write_ndjson(tmp_path / "n.ndjson", [{"id": 1, "tags": ["a", "b"], "meta": {"k": 1}}, {"id": 2, "tags": [], "meta": None}])
    # nested="text" keeps objects and arrays as JSON text; the default reads structs and lists (test_structs.py)
    t = ia.read_ndjson(p, nested="text").sort("id").to_arrow()
    assert t.column("tags").to_pylist() == ['["a", "b"]', "[]"]
    assert json.loads(t.column("meta").to_pylist()[0]) == {"k": 1}
    assert t.column("meta").to_pylist()[1] is None


def test_large_files_span_morsels(tmp_path: Path) -> None:
    rows = [{"id": i, "g": f"g{i % 13}", "v": (i % 1000) / 8, "s": None if i % 7 == 0 else f"é{i}"} for i in range(150_000)]
    p = write_ndjson(tmp_path / "big.ndjson", rows)
    assert os.path.getsize(p) > 4 << 20  # more than one 4 MiB morsel
    q = "select g, count(*) as n, sum(v) as sv, count(s) as cs, min(id) as lo, max(id) as hi from t group by g order by g"
    ctx = ia.SessionContext().register_json("t", p)
    got = ctx.sql(q).collect().to_arrow()
    assert diff(got, ddb(q.replace("from t", f"from read_json('{p}', format='newline_delimited')"))) is None


def test_folder_and_glob(tmp_path: Path) -> None:
    write_ndjson(tmp_path / "a.ndjson", ROWS[:2])
    write_ndjson(tmp_path / "b.jsonl", ROWS[2:4])
    (tmp_path / "c.json").write_text(json.dumps(ROWS[4:]), encoding="utf-8")
    assert ia.read_ndjson(str(tmp_path), format="auto").to_arrow().num_rows == 5
    assert ia.read_ndjson(str(tmp_path / "*.ndjson")).to_arrow().num_rows == 2


def test_write_ndjson_round_trip_and_duckdb_reads_it(tmp_path: Path) -> None:
    df = ia.from_arrow(
        pa.table(
            {
                "i": pa.array([1, None, 3], pa.int64()),
                "f": pa.array([1.0, 2.5, None]),
                "b": pa.array([True, None, False]),
                "s": pa.array(["é ☃ \"q\"", "line\nbreak", None]),
            }
        )
    )
    p = str(tmp_path / "out.ndjson")
    df.write_ndjson(p)
    back = ia.read_ndjson(p).to_arrow()
    assert diff(back, df.to_arrow()) is None
    assert diff(back, ddb(f"select * from read_json('{p}', format='newline_delimited')")) is None
    assert [json.loads(l) for l in Path(p).read_text(encoding="utf-8").splitlines()][1] == {"i": None, "f": 2.5, "b": None, "s": "line\nbreak"}
    # streaming sink and COPY
    q = str(tmp_path / "sink.ndjson")
    assert df.lazy().sink_ndjson(q) == 3
    assert Path(q).read_text(encoding="utf-8") == Path(p).read_text(encoding="utf-8")
    c = str(tmp_path / "copy.json")
    ctx = ia.SessionContext().register_json("t", p)
    ctx.sql(f"copy (select i, s from t order by i nulls last) to '{c}' (format json)").collect()
    assert ia.read_ndjson(c).to_arrow().num_rows == 3


def test_ndjson_error_messages(tmp_path: Path) -> None:
    p = tmp_path / "bad.ndjson"
    p.write_text('{"a": 1}\n{"a": \n', encoding="utf-8")
    with pytest.raises(Exception, match="invalid JSON"):
        ia.read_ndjson(str(p), infer_schema_length=1)


def test_catalog_json_tables(tmp_path: Path) -> None:
    write_ndjson(tmp_path / "events.ndjson", ROWS)
    (tmp_path / "plain.json").write_text(json.dumps(ROWS), encoding="utf-8")
    cfg = parse_config('[tables.events]\npath = "events.ndjson"\n[tables.plain]\npath = "plain.json"\n[tables.x]\npath = "e"\nformat = "json"\n', tmp_path)
    assert [t.format for t in cfg.tables] == ["json", "json", "json"]
    ctx = ia.SessionContext()
    for t in cfg.tables[:2]:
        t.register(ctx)
    assert ctx.sql("select count(*) as n from events").collect().to_arrow().column("n")[0].as_py() == 5
    assert ctx.sql("select count(*) as n from plain").collect().to_arrow().column("n")[0].as_py() == 5


# ---------------------------------------------------------------------------
# CSV options
# ---------------------------------------------------------------------------

CSV = "junk\n# comment\nid;name;v\n1;'a;b';NA\n2;'it''s';5\n# note\n3;plain;-\n"


def test_csv_options_vs_duckdb(tmp_path: Path) -> None:
    p = tmp_path / "o.csv"
    p.write_text(CSV, encoding="utf-8")
    got = ia.read_csv(
        str(p),
        separator=";",
        skip_rows=1,
        comment="#",
        quote_char="'",
        null_values=["NA", "-"],
        schema_overrides={"v": "float64"},
    ).sort("id").to_arrow()
    want = ddb(
        f"select * from read_csv('{p}', delim=';', skip=1, comment='#', quote='''', escape='''', "
        "nullstr=['NA', '-'], types={'v': 'DOUBLE'}) order by id"
    )
    assert diff(got, want) is None
    assert got.column("name").to_pylist() == ["a;b", "it's", "plain"]
    assert str(got.schema.field("v").type) == "double"


def test_csv_columns_select_and_order(tmp_path: Path) -> None:
    p = tmp_path / "c.csv"
    p.write_text("a,b,c\n1,x,2.5\n3,y,4.5\n", encoding="utf-8")
    t = ia.read_csv(str(p), columns=["c", "a"]).to_arrow()
    assert t.column_names == ["c", "a"]
    assert diff(t, ddb(f"select c, a from read_csv('{p}')")) is None
    with pytest.raises(Exception, match="no column"):
        ia.read_csv(str(p), columns=["zzz"])
    with pytest.raises(Exception, match="no column"):
        ia.read_csv(str(p), dtypes={"zzz": "int64"})


def test_csv_dtypes_alias_and_try_parse_dates(tmp_path: Path) -> None:
    p = tmp_path / "d.csv"
    p.write_text("id,when\n1,2024-02-29\n2,2023-12-31\n", encoding="utf-8")
    assert str(ia.read_csv(str(p)).to_arrow().schema.field("when").type) == "date32[day]"
    t = ia.read_csv(str(p), try_parse_dates=False, dtypes={"id": "float64"}).to_arrow()
    assert [str(f.type) for f in t.schema] == ["double", "string"]
    assert t.column("when").to_pylist() == ["2024-02-29", "2023-12-31"]


def test_csv_encoding_lossy(tmp_path: Path) -> None:
    p = tmp_path / "e.csv"
    p.write_bytes(b"id,s\n1,caf\xe9\n2,ok\n")
    with pytest.raises(Exception):
        ia.read_csv(str(p))
    t = ia.read_csv(str(p), encoding="utf8-lossy").sort("id").to_arrow()
    assert t.column("s").to_pylist() == ["caf�", "ok"]
    with pytest.raises(Exception, match="encoding"):
        ia.read_csv(str(p), encoding="latin1")


def test_csv_escape_and_null_values_across_morsels(tmp_path: Path) -> None:
    p = tmp_path / "m.csv"
    lines = ["# header comment", "id,txt,v"]
    for i in range(200_000):
        lines.append(f'{i},"a\\"b {i}",{"NULL" if i % 4 == 0 else i}')
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert os.path.getsize(p) > 4 << 20
    t = ia.read_csv(str(p), skip_rows=1, escape="\\", null_values="NULL").to_arrow()
    assert t.num_rows == 200_000
    assert t.column("v").null_count == 50_000
    assert t.column("txt")[7].as_py() == 'a"b 7'


def test_sql_read_csv_named_args(tmp_path: Path) -> None:
    p = tmp_path / "s.csv"
    p.write_text(CSV, encoding="utf-8")
    ctx = ia.SessionContext()
    q = (
        f"select * from read_csv('{p}', delim=';', skip=1, comment='#', quote='''', "
        "nullstr=['NA', '-'], columns=['v', 'id'], types={'v': 'DOUBLE'}) order by id"
    )
    assert ctx.sql(q).collect().to_arrow().column_names == ["v", "id"]


def test_copy_csv_quote_and_null(tmp_path: Path) -> None:
    out = tmp_path / "o.csv"
    ia.SessionContext().sql(
        f"copy (select 'a|b' as s, null as n) to '{out}' (format csv, delimiter '|', quote '\"', nullstr 'NULL')"
    ).collect()
    assert out.read_text() == 's|n\n"a|b"|NULL\n'


def test_polars_parity_when_available(tmp_path: Path) -> None:
    pl = pytest.importorskip("polars")
    p = write_ndjson(tmp_path / "a.ndjson", ROWS)
    got = ia.read_ndjson(p).sort("id").to_arrow()
    want = pl.read_ndjson(p).sort("id").to_arrow()
    assert diff(got, want) is None
    c = tmp_path / "p.csv"
    c.write_text("a,b\n1,NA\n2,x\n", encoding="utf-8")
    got = ia.read_csv(str(c), null_values="NA", skip_rows=0).to_arrow()
    want = pl.read_csv(c, null_values="NA").to_arrow()
    assert got.column("b").to_pylist() == want.column("b").to_pylist()
