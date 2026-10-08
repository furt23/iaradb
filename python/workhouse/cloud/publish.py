"""Publishing the engine for clusters: a Linux x86_64 wheel, cross-compiled
here with zig (portable x86-64-v3: AVX2, any recent Intel or AMD machine),
uploaded to ``s3://workhouse-artifacts-<account>-<region>/engine/<version>/``."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from workhouse.cloud.aws import TAG_COMPONENT, artifacts_bucket, error_code, log

TARGET = "x86_64-unknown-linux-gnu"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def zig_binary() -> str:
    """zig from the ``ziglang`` package (``uv pip install ziglang``)."""
    try:
        import ziglang
    except ImportError as e:
        raise SystemExit("zig is needed to build Linux wheels: uv pip install ziglang") from e
    folder = Path(ziglang.__file__).parent
    exe = folder / ("zig.exe" if sys.platform == "win32" else "zig")
    if not exe.exists():
        raise SystemExit(f"zig not found in {folder}")
    return str(exe)


def maturin_binary() -> str:
    found = shutil.which("maturin") or str(Path(sys.executable).parent / ("maturin.exe" if sys.platform == "win32" else "maturin"))
    if not Path(found).exists():
        raise SystemExit("maturin is needed: uv pip install maturin")
    return found


def build(out: Path) -> Path:
    """Cross-compile the Linux wheel; returns its path."""
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.whl"):
        old.unlink()
    env = {**os.environ, "CARGO_ZIGBUILD_ZIG_PATH": zig_binary(), "RUSTFLAGS": "-C target-cpu=x86-64-v3"}
    cmd = [maturin_binary(), "build", "--release", "--target", TARGET, "--zig", "--compatibility", "manylinux_2_28", "--out", str(out)]
    log("building the engine for Linux (a few minutes)")
    subprocess.run(cmd, cwd=repo_root(), env=env, check=True)
    wheels = sorted(out.glob("*.whl"))
    if not wheels:
        raise SystemExit("maturin produced no wheel")
    return wheels[-1]


def ensure_bucket(s3: Any, name: str, region: str) -> None:
    try:
        s3.head_bucket(Bucket=name)
        return
    except Exception as e:  # noqa: BLE001
        if error_code(e) not in ("404", "NoSuchBucket", "NotFound"):
            raise
    args: dict[str, Any] = {"Bucket": name}
    if region != "us-east-1":
        args["CreateBucketConfiguration"] = {"LocationConstraint": region}
    s3.create_bucket(**args)
    s3.put_public_access_block(
        Bucket=name,
        PublicAccessBlockConfiguration={"BlockPublicAcls": True, "IgnorePublicAcls": True, "BlockPublicPolicy": True, "RestrictPublicBuckets": True},
    )
    s3.put_bucket_tagging(Bucket=name, Tagging={"TagSet": [{"Key": TAG_COMPONENT, "Value": "clusters"}]})
    log(f"created s3://{name}")


def upload(sess: Any, wheel: Path, version: str) -> str:
    """Upload the wheel as the engine of ``version`` (older builds of it are removed)."""
    s3 = sess.client("s3")
    bucket = artifacts_bucket(sess)
    ensure_bucket(s3, bucket, sess.region_name)
    prefix = f"engine/{version}/"
    for o in s3.list_objects_v2(Bucket=bucket, Prefix=prefix).get("Contents", []):
        s3.delete_object(Bucket=bucket, Key=o["Key"])
    key = prefix + wheel.name
    s3.upload_file(str(wheel), bucket, key)
    url = f"s3://{bucket}/{key}"
    log(f"published {url} ({wheel.stat().st_size / 1e6:.1f} MB)")
    return url


def publish(sess: Any, wheel: Path | None = None) -> str:
    import workhouse

    wheel = wheel or build(repo_root() / "target" / "wheels-linux")
    return upload(sess, wheel, workhouse.__version__)
