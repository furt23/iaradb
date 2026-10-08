"""``python -m workhouse.cloud <command>`` (see workhouse.cloud)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from workhouse.cloud import publish, resources
from workhouse.cloud.aws import session


def parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="python -m workhouse.cloud", description=__doc__)
    ap.add_argument("command", choices=["publish", "verify", "cleanup"])
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--wheel", default=None, help="publish: an already built Linux wheel instead of building one")
    ap.add_argument("--yes", action="store_true", help="cleanup: do not ask")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    a = parse(sys.argv[1:] if argv is None else argv)
    sess = session(a.region)
    if a.command == "publish":
        publish.publish(sess, Path(a.wheel) if a.wheel else None)
    elif a.command == "verify":
        left = resources.leftovers(sess)
        for item in left:
            print(f"LEFT: {item}")
        print("nothing left" if not left else f"{len(left)} resource(s) left")
        return 1 if left else 0
    elif a.command == "cleanup":
        if not a.yes and input("terminate every cluster machine and delete Workhouse's AWS resources? [y/N] ").strip().lower() != "y":
            return 1
        resources.cleanup(sess)
    return 0


if __name__ == "__main__":
    sys.exit(main())
