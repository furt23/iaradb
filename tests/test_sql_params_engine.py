"""Bound SQL parameters: ``$1`` / ``?`` with a list or tuple, ``:name`` / ``$name`` with a dict."""

from __future__ import annotations

import datetime as dt
import decimal

import pyarrow as pa
import pytest

import workhouse as wh
from workhouse.workspaces import Workspace

T = pa.table({"id": [1, 2, 3, 4], "name": ["a:b", "bob", "carol", "dave"]})


def one(query: str, params=None, **tables):
    return wh.sql(query, params, **tables).collect().to_arrow().to_pylist()[0]


def ids(query: str, params=None):
    return [r["id"] for r in wh.sql(query, params, t=T).collect().to_arrow().to_pylist()]


def test_positional_styles():
    assert ids("select id from t where id >= $1 and id <= $2 order by id", [2, 3]) == [2, 3]
    assert ids("select id from t where id >= ? and id <= ? order by id", (2, 3)) == [2, 3]
    assert ids("select id from t where id = $2 or id = $1 or id = $2 order by id", [1, 4]) == [1, 4]


def test_named_styles():
    assert ids("select id from t where id between :lo and :hi order by id", {"lo": 2, "hi": 3}) == [2, 3]
    assert ids("select id from t where id between $lo and $hi order by id", {"lo": 2, "hi": 3}) == [2, 3]
    assert ids("select id from t where id = :a limit :n", {"a": 1, "n": 5, "unused": "x"}) == [1]


def test_params_is_reserved_and_optional():
    assert one("select 1 as x") == {"x": 1}
    assert one("select count(*) as n from t where id > :k", {"k": 2}, t=T) == {"n": 2}
    # the keyword form works too
    assert wh.sql("select $1 as x", params=[5]).collect().to_arrow().to_pylist() == [{"x": 5}]


@pytest.mark.parametrize(
    "value, expected",
    [
        (7, 7),
        (1.5, 1.5),
        ("it's", "it's"),
        (True, True),
        (None, None),
        (dt.date(2024, 1, 2), dt.date(2024, 1, 2)),
        (dt.datetime(2024, 1, 2, 3, 4, 5, 678), dt.datetime(2024, 1, 2, 3, 4, 5, 678)),
        (decimal.Decimal("123.45"), decimal.Decimal("123.45")),
        (b"\x00\xffab", b"\x00\xffab"),
    ],
)
def test_value_types_round_trip(value, expected):
    assert one("select $1 as v", [value])["v"] == expected
    assert one("select :v as v", {"v": value})["v"] == expected


def test_aware_datetime_is_utc():
    value = dt.datetime(2024, 1, 2, 3, 0, 0, tzinfo=dt.timezone(dt.timedelta(hours=2)))
    got = one("select $1 as v", [value])["v"]
    assert got == dt.datetime(2024, 1, 2, 1, 0, 0, tzinfo=dt.timezone.utc)


def test_typed_comparisons():
    t = pa.table({"d": [dt.date(2024, 1, 1), dt.date(2024, 6, 1)], "p": [decimal.Decimal("1.50"), decimal.Decimal("9.99")]})
    assert wh.sql("select count(*) as n from t where d >= :d", {"d": dt.date(2024, 3, 1)}, t=t).collect().to_arrow().to_pylist() == [{"n": 1}]
    assert wh.sql("select count(*) as n from t where p > $1", [decimal.Decimal("2")], t=t).collect().to_arrow().to_pylist() == [{"n": 1}]


def test_text_is_a_value_not_sql():
    evil = "x'; drop table t; --"
    assert one("select $1 as v", [evil])["v"] == evil
    assert one("select count(*) as n from t where name = $1", [evil], t=T) == {"n": 0}


def test_literals_comments_and_casts_untouched():
    assert one("select '? $1 :name' as v")["v"] == "? $1 :name"
    assert one("select 1 as v -- ? :x $1\n")["v"] == 1
    assert one("select id::bigint as v from t where id = 1", t=T)["v"] == 1


def test_missing_parameters_error():
    with pytest.raises(Exception, match=r"\$2.*\$3|\$3.*\$2"):
        wh.sql("select ? + ? + ?", [1])
    with pytest.raises(Exception, match=":a"):
        wh.sql("select :a + :b", {"b": 1})
    with pytest.raises(Exception, match=r"\$1"):
        wh.sql("select $1")


def test_mixing_styles_error():
    with pytest.raises(Exception, match="mix"):
        wh.sql("select ? + $2", [1, 2])
    with pytest.raises(Exception, match="mix"):
        wh.sql("select $1 + :a", [1, 2])
    with pytest.raises(Exception, match="named"):
        wh.sql("select :a", [1])
    with pytest.raises(Exception, match="positional"):
        wh.sql("select $1", {"a": 1})


def test_bad_parameter_values():
    with pytest.raises(TypeError, match="parameter 1"):
        wh.sql("select $1", [object()])
    with pytest.raises(TypeError, match="list, tuple or dict"):
        wh.sql("select $1", "abc")
    with pytest.raises(TypeError, match="string keys"):
        wh.sql("select :a", {1: 2})


def test_session_and_frame_sql():
    ctx = wh.SessionContext()
    ctx.register("t", T)
    assert ctx.sql("select count(*) as n from t where id > ?", [2]).collect().to_arrow().to_pylist() == [{"n": 2}]
    df = wh.from_arrow(T)
    assert df.sql("select count(*) as n from self where id > :k", params={"k": 3}).to_arrow().to_pylist() == [{"n": 1}]


def test_workspace_sql_and_writes(tmp_path):
    ws = Workspace(tmp_path, "ws")
    assert ws.sql("select count(*) as n from t where id > :k", {"k": 1}, t=T).collect().to_arrow().to_pylist() == [{"n": 3}]
    # a statement that writes
    ws.sql("create table big as select id from t where id >= $1", [3], t=T)
    assert ws.sql("select count(*) as n from big").collect().to_arrow().to_pylist() == [{"n": 2}]
    ws.sql("insert into big select id from t where id = ?", [1], t=T)
    assert ws.sql("select count(*) as n from big").collect().to_arrow().to_pylist() == [{"n": 3}]
    out = tmp_path / "out.csv"
    ws.sql(f"copy (select id from t where id > :k) to '{out.as_posix()}' (format csv)", {"k": 2}, t=T)
    assert out.read_text().split() == ["id", "3", "4"]
    with pytest.raises(Exception, match=":k"):
        ws.sql("create table nope as select id from t where id > :k", t=T)
