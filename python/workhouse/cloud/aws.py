"""boto3 sessions from the environment and the names the Studio uses in AWS."""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from typing import Any, TypeVar

T = TypeVar("T")

#: tag on everything Workhouse creates (value: "clusters" for shared resources, "cluster" for machines)
TAG_COMPONENT = "workhouse:component"
TAG_CLUSTER = "workhouse:cluster"
SECURITY_GROUP = "workhouse-clusters"
ROLE = "workhouse-cluster"


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


def artifacts_bucket(sess: Any) -> str:
    """The bucket holding engine builds (the same name the Studio computes)."""
    account = sess.client("sts").get_caller_identity()["Account"]
    return f"workhouse-artifacts-{account}-{sess.region_name}"


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
