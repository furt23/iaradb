"""``python -m iara.cloud <command>`` (see iara.cloud)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from iara.cloud import publish, resources
from iara.cloud.aws import session, team_id


def parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="python -m iara.cloud", description=__doc__)
    ap.add_argument("command", choices=["publish", "verify", "cleanup"])
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--wheel", default=None, help="publish: an already built Linux wheel instead of building one")
    ap.add_argument("--yes", action="store_true", help="cleanup: do not ask")
    ap.add_argument(
        "--team",
        default=None,
        help="verify, cleanup: only this team's resources (default: env IARA_TEAM; unset: every team and the legacy names)",
    )
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    a = parse(sys.argv[1:] if argv is None else argv)
    team = None
    if a.command in ("verify", "cleanup"):
        try:
            team = team_id(a.team)
        except ValueError as e:
            raise SystemExit(str(e)) from e
    sess = session(a.region)
    if a.command == "publish":
        publish.publish(sess, Path(a.wheel) if a.wheel else None)
    elif a.command == "verify":
        left = resources.leftovers(sess, team)
        for item in left:
            print(f"LEFT: {item}")
        print("nothing left" if not left else f"{len(left)} resource(s) left")
        return 1 if left else 0
    elif a.command == "cleanup":
        if team is None:
            question = "terminate every cluster machine of every team and delete Iara's AWS resources (no --team)? [y/N] "
        else:
            question = f"terminate the cluster machines of team {team} and delete its AWS resources? [y/N] "
        if not a.yes and input(question).strip().lower() != "y":
            return 1
        resources.cleanup(sess, team)
    return 0


if __name__ == "__main__":
    sys.exit(main())
