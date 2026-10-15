"""``python -m iara.kernel --workspace <dir>``"""

from __future__ import annotations

import argparse
import os

from iara.kernel.protocol import Channel
from iara.kernel.server import KernelServer
from iara.kernel.session import KernelSession


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m iara.kernel", description=__doc__)
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
