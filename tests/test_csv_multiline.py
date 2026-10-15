"""CSV fields with quoted newlines, read over parallel byte ranges, compared with DuckDB.

The scan cuts files into ranges of at least 4 MiB, so the file is written with a
quoted newline just before, at, and just after each multiple of 4 MiB.

Needs the extension rebuilt."""

from __future__ import annotations

from pathlib import Path

import duckdb
import pyarrow as pa
import pytest

import iara as ia

CUT = 4 << 20
ROWS = 600_000  # about 20 MiB: four cuts


def ddb(query: str) -> pa.Table:
    return duckdb.connect().execute(query).fetch_arrow_table()


def build(path: Path, escapes: bool) -> None:
    out: list[str] = ["id,text,n\n"]
    size = len(out[0])
    for i in range(ROWS):
        head = f'{i},"'
        next_cut = (size // CUT + 1) * CUT
        if size + len(head) + 8 < next_cut and next_cut - size < 200:
            target = next_cut - 1 + i % 3
            pad = target - size - len(head) - (2 if escapes else 0)
            pre, post = ('"', '"tail') if escapes else ("", "tail")
            text = "x" * pad + pre + "\n" + post + "\nlast"
        elif i % 7 == 0:
            text = f"two\nlines {i}"
        else:
            text = f"plain {i}"
        row = f'{head}{text.replace(chr(34), chr(34) * 2)}",{i * 3}\n'
        out.append(row)
        size += len(row)
    path.write_text("".join(out), encoding="utf-8", newline="")


@pytest.mark.parametrize("escapes", [False, True])
def test_multiline_fields_at_range_boundaries(tmp_path: Path, escapes: bool) -> None:
    p = tmp_path / "big.csv"
    build(p, escapes)
    got = ia.read_csv(str(p)).sort("id").to_arrow()
    want = ddb(f"select * from read_csv('{p.as_posix()}', header=true, strict_mode=true) order by id")
    assert got.num_rows == want.num_rows == ROWS
    assert got.column("text").to_pylist() == want.column("text").to_pylist()
    assert got.column("n").to_pylist() == want.column("n").to_pylist()


def test_stray_quote_reads_the_file_whole(tmp_path: Path) -> None:
    p = tmp_path / "stray.csv"
    p.write_text('id,text,n\n0,5" pipe,0\n' + "".join(f"{i},row {i},{i}\n" for i in range(1, 1000)))
    got = ia.read_csv(str(p)).sort("id").to_arrow()
    assert got.num_rows == 1000
    assert got.column("text")[0].as_py() == '5" pipe'
