from __future__ import annotations

from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest


@pytest.fixture(autouse=True)
def _no_active_workspace():
    """In-process kernel sessions make their workspace the active one."""
    yield
    from iara.workspaces import set_active

    set_active(None)


@pytest.fixture()
def workspace(tmp_path: Path) -> Path:
    """A workspace with a Parquet table, a CSV table and a notebooks folder."""
    (tmp_path / "data").mkdir()
    pq.write_table(
        pa.table({"id": list(range(1000)), "grp": [i % 7 for i in range(1000)], "amount": [i * 0.5 for i in range(1000)]}),
        tmp_path / "data" / "sales.parquet",
    )
    (tmp_path / "data" / "regions.csv").write_text("grp,region\n0,north\n1,south\n2,east\n3,west\n")
    (tmp_path / "iara.toml").write_text(
        '[workspace]\nname = "demo"\n\n'
        '[tables.sales]\npath = "data/sales.parquet"\n\n'
        '[tables.regions]\npath = "data/regions.csv"\n'
    )
    (tmp_path / "notebooks").mkdir()
    return tmp_path
