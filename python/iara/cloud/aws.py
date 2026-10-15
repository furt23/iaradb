"""boto3 sessions from the environment and the names the Studio uses in AWS."""

from __future__ import annotations

import os
import re
import time
from collections.abc import Callable
from typing import Any, TypeVar

T = TypeVar("T")

#: tag on everything Iara creates (value: "clusters" for shared resources, "cluster" for machines)
TAG_COMPONENT = "iara:component"
TAG_CLUSTER = "iara:cluster"
#: tag with the team id on a team's machines, volumes, network interfaces, security group and role
TAG_TEAM = "iara:team"
#: legacy (unscoped) names; a team's names append "-<team>"
SECURITY_GROUP = "iara-clusters"
ROLE = "iara-cluster"
#: environment variable holding the team id when ``--team`` is not given
TEAM_ENV = "IARA_TEAM"

_TEAM = re.compile(r"[a-z0-9][a-z0-9-]{0,30}")


def session(region: str) -> Any:
    """A boto3 session: standard ``AWS_*`` variables, else ``ACCESS_KEY`` /
    ``SECRET_KEY`` (as in a project's dotenv file)."""
    import boto3

    key = os.environ.get("AWS_ACCESS_KEY_ID") or os.environ.get("ACCESS_KEY")
    secret = os.environ.get("AWS_SECRET_ACCESS_KEY") or os.environ.get("SECRET_KEY")
    if not key or not secret:
        raise SystemExit("no AWS credentials: set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or ACCESS_KEY / SECRET_KEY)")
    token = os.environ.get("AWS_SESSION_TOKEN")
    return boto3.Session(aws_access_key_id=key, aws_secret_access_key=secret, aws_session_token=token, region_name=region)


def _checked_team(team: str, where: str) -> str:
    if not _TEAM.fullmatch(team):
        raise ValueError(f"invalid team id {team!r} in {where}: use 1 to 31 lowercase letters, digits or hyphens, starting with a letter or digit")
    return team


def team_id(value: str | None) -> str | None:
    """The team of this run: ``value`` (``--team``) when given, else env ``IARA_TEAM``
    (an empty variable counts as unset). None when neither is set: legacy names and every team.
    Raises ValueError unless the id matches ``^[a-z0-9][a-z0-9-]{0,30}$``."""
    if value is not None:
        return _checked_team(value, "--team")
    env = os.environ.get(TEAM_ENV) or None
    if env is None:
        return None
    return _checked_team(env, TEAM_ENV)


def security_group_name(team: str | None) -> str:
    """The security group's name: the legacy one without a team, else ``iara-clusters-<team>``."""
    return SECURITY_GROUP if team is None else f"{SECURITY_GROUP}-{_checked_team(team, 'team')}"


def role_name(team: str | None) -> str:
    """The IAM role's and instance profile's name: the legacy one without a team, else ``iara-cluster-<team>``."""
    return ROLE if team is None else f"{ROLE}-{_checked_team(team, 'team')}"


def artifacts_bucket(sess: Any) -> str:
    """The bucket holding engine builds (the same name the Studio computes)."""
    account = sess.client("sts").get_caller_identity()["Account"]
    return f"iara-artifacts-{account}-{sess.region_name}"


def error_code(e: Exception) -> str:
    return getattr(e, "response", {}).get("Error", {}).get("Code", "")


def retry(fn: Callable[[], T], codes: tuple[str, ...], attempts: int = 30, delay: float = 5.0) -> T:
    """Call ``fn``, retrying while AWS answers one of ``codes`` (eventual consistency)."""
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 - botocore errors are dynamic classes
            if error_code(e) not in codes or i == attempts - 1:
                raise
            time.sleep(delay)
    raise AssertionError("unreachable")


def log(msg: str) -> None:
    print(f"[cloud] {msg}", flush=True)
