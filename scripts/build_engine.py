"""Build the engine into the repository's virtualenv (`maturin develop --release`).

Running kernels keep the built extension (`python/iara/_iara.pyd` on Windows)
open, and Windows refuses to overwrite an open file: the current one is moved
aside first (`_iara.pyd.oldN`, gitignored), and old copies no process holds any
more are deleted.

    uv run --no-sync python scripts/build_engine.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent / "python" / "iara"


def _clear_old_copies() -> None:
    for old in PACKAGE.glob("_iara.*.old*"):
        try:
            old.unlink()
        except OSError:
            pass  # still loaded by a running kernel


def _move_aside_built() -> None:
    for built in PACKAGE.glob("_iara.*"):
        if built.suffix not in (".pyd", ".so"):
            continue
        n = 1
        while built.with_name(f"{built.name}.old{n}").exists():
            n += 1
        built.rename(built.with_name(f"{built.name}.old{n}"))


def main() -> int:
    _clear_old_copies()
    _move_aside_built()
    return subprocess.call([sys.executable, "-m", "maturin", "develop", "--release"])


if __name__ == "__main__":
    raise SystemExit(main())
