"""Generate the example workspace's data.

    python examples/workspace/setup_data.py [scale_factor]     # TPC-H, default 0.1 (~100 MB) -> data/tpch
    python examples/workspace/setup_data.py --big [sf]         # a larger copy, default 10 -> data/tpch_sf<sf>

``--big`` registers its tables as ``<table>_sf<sf>`` (``lineitem_sf10``, ...)
for the heavier tour (``notebooks/tpch_heavy.py``). When the benchmarks
already generated that scale (``benchmarks/data/sf<sf>``) its files are
hard-linked: no extra disk space. Otherwise they are generated (SF10 needs
about 2.5 GB of Parquet plus a temporary database of a few times that).

Uses DuckDB's TPC-H extension (``uv pip install duckdb``).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
GENERATOR = ROOT / "benchmarks" / "gen_tpch.py"
TABLES = ["lineitem", "orders", "customer", "part", "partsupp", "supplier", "nation", "region"]


def generate(sf: str, out: Path) -> None:
    subprocess.run([sys.executable, str(GENERATOR), sf, str(out)], check=True)


def link_tree(src: Path, dst: Path) -> None:
    """Hard-link every file of ``src`` into ``dst`` (copy across volumes)."""
    for f in src.rglob("*.parquet"):
        target = dst / f.relative_to(src)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            continue
        try:
            os.link(f, target)
        except OSError:
            shutil.copy2(f, target)


def register_big(sf: str) -> None:
    """Add ``<table>_sf<sf>`` entries to iara.toml (once)."""
    config = HERE / "iara.toml"
    text = config.read_text(encoding="utf-8")
    tag = f"sf{sf.replace('.', '_')}"
    entries = [f'\n[tables.{t}_{tag}]\npath = "data/tpch_{tag}/{t}"\n' for t in TABLES if f"[tables.{t}_{tag}]" not in text]
    if entries:
        config.write_text(text.rstrip("\n") + "\n" + "".join(entries), encoding="utf-8")


def big(sf: str) -> None:
    tag = f"sf{sf.replace('.', '_')}"
    out = HERE / "data" / f"tpch_{tag}"
    bench = ROOT / "benchmarks" / "data" / tag
    if bench.is_dir() and all((bench / t).is_dir() for t in TABLES):
        link_tree(bench, out)
        print(f"linked {bench} -> {out}")
    else:
        generate(sf, out)
    register_big(sf)
    print(f"tables registered as <table>_{tag}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--big":
        big(args[1] if len(args) > 1 else "10")
    else:
        sf = args[0] if args else "0.1"
        generate(sf, HERE / "data" / "tpch")
        print(f"data written to {HERE / 'data' / 'tpch'}")
