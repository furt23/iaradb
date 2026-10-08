"""``python -m workhouse.kernel --workspace <dir>``"""

from __future__ import annotations

import argparse
import os

from workhouse.kernel.protocol import Channel
from workhouse.kernel.server import KernelServer
from workhouse.kernel.session import KernelSession


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m workhouse.kernel", description=__doc__)
    ap.add_argument("--workspace", default=None, help="workspace root (default: discovered from the current directory)")
    ap.add_argument("--create", action="store_true", help="create the workspace directory if missing (remote kernels)")
    args = ap.parse_args()
    if args.workspace:
        args.workspace = os.path.expanduser(args.workspace)
        if args.create:
            os.makedirs(args.workspace, exist_ok=True)
    channel = Channel.over_stdio()
    KernelServer(channel, KernelSession(args.workspace)).serve()
    # daemon threads (a cell still running Python code) must not keep us alive
    os._exit(0)


if __name__ == "__main__":
    main()
