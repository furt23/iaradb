"""``python -m iara.cloud <command>`` (see iara.cloud)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from iara.cloud import publish, resources, team
from iara.cloud.aws import session, team_id, user_name


def parse(argv: list[str]) -> argparse.Namespace:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--region", default="us-east-1")
    ap = argparse.ArgumentParser(prog="python -m iara.cloud", description=__doc__)
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("publish", parents=[common], help="build the engine for Linux and upload it for clusters")
    p.add_argument("--wheel", default=None, help="an already built Linux wheel instead of building one")

    scoped = argparse.ArgumentParser(add_help=False)
    scoped.add_argument("--team", default=None, help="only this team's resources (default: env IARA_TEAM; unset: every team and the legacy names)")
    sub.add_parser("verify", parents=[common, scoped], help="list what of Iara is left in the account (exit 1 if anything)")
    p = sub.add_parser("cleanup", parents=[common, scoped], help="terminate cluster machines and delete the shared resources")
    p.add_argument("--yes", action="store_true", help="do not ask")
    p.add_argument("--with-users", action="store_true", help="also delete the Studio users and their access keys")

    p = sub.add_parser("team-setup", parents=[common], help="create a team's AWS resources and Studio key (admin credentials)")
    p.add_argument("team")
    p.add_argument("--new-key", action="store_true", help="create an access key even if the team's user already has one")
    p = sub.add_parser("team-remove", parents=[common], help="delete a team's AWS resources and Studio user (admin credentials)")
    p.add_argument("team")
    p.add_argument("--yes", action="store_true", help="do not ask")
    return ap.parse_args(argv)


def _team(value: str | None, where: str = "--team") -> str | None:
    try:
        return team_id(value, where)
    except ValueError as e:
        raise SystemExit(str(e)) from e


def _cleanup(sess: Any, a: argparse.Namespace) -> int:
    t = _team(a.team)
    scope = "every cluster machine of every team (no --team)" if t is None else f"the cluster machines of team {t}"
    users = " and the Studio users with their access keys" if a.with_users else ""
    if not a.yes and input(f"terminate {scope} and delete Iara's AWS resources{users}? [y/N] ").strip().lower() != "y":
        return 1
    resources.cleanup(sess, t, users=a.with_users)
    return 0


def _team_setup(sess: Any, a: argparse.Namespace) -> int:
    t = _team(a.team, "team")
    assert t is not None
    key = team.setup(sess, t, new_key=a.new_key)
    if key is None:
        return 0
    # the secret is shown once, here: stdout carries nothing else
    print(f"IARA_AWS_ACCESS_KEY_ID={key[0]}")
    print(f"IARA_AWS_SECRET_ACCESS_KEY={key[1]}")
    note = f"paste both lines into docker/{t}.env (and IARA_AWS_REGION={sess.region_name} if that is not us-east-1); AWS will not show the secret again"
    print(note, file=sys.stderr)
    return 0


def _team_remove(sess: Any, a: argparse.Namespace) -> int:
    t = _team(a.team, "team")
    assert t is not None
    if not a.yes and input(f"delete the AWS resources of team {t} and the user {user_name(t)} with its access keys? [y/N] ").strip().lower() != "y":
        return 1
    team.remove(sess, t)
    return 0


def main(argv: list[str] | None = None) -> int:
    a = parse(sys.argv[1:] if argv is None else argv)
    if a.command == "verify":
        left = resources.leftovers(session(a.region), _team(a.team))
        for item in left:
            print(f"LEFT: {item}")
        print("nothing left" if not left else f"{len(left)} resource(s) left")
        return 1 if left else 0
    sess = session(a.region)
    if a.command == "publish":
        publish.publish(sess, Path(a.wheel) if a.wheel else None)
        return 0
    return {"cleanup": _cleanup, "team-setup": _team_setup, "team-remove": _team_remove}[a.command](sess, a)


if __name__ == "__main__":
    sys.exit(main())
