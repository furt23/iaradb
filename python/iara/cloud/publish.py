"""Publishing the engine for clusters: a Linux x86_64 wheel, cross-compiled
here with zig (portable x86-64-v3: AVX2, any recent Intel or AMD machine), and
the ``iara-s3-proxy`` binary (the team bucket's proxy on the machine), uploaded
to ``s3://iara-artifacts-<account>-<region>/engine/<version>/``."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from iara.cloud.aws import TAG_COMPONENT, artifacts_bucket, error_code, log

TARGET = "x86_64-unknown-linux-gnu"
#: the oldest glibc the proxy runs on (Amazon Linux 2023 has 2.34)
PROXY_GLIBC = "2.28"
#: the object the boot script downloads (apps/web/src/server/compute/userData.ts: proxyUrlOf)
PROXY_NAME = "iara-s3-proxy-x86_64"


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


def cargo_zigbuild_binary() -> str:
    found = shutil.which("cargo-zigbuild") or str(Path(sys.executable).parent / ("cargo-zigbuild.exe" if sys.platform == "win32" else "cargo-zigbuild"))
    if not Path(found).exists():
        raise SystemExit("cargo-zigbuild is needed to build the proxy: uv pip install cargo-zigbuild")
    return found


def build_proxy(out: Path) -> Path:
    """Cross-compile the team bucket's proxy for Linux x86_64 (zig, like the wheel); returns the file to upload."""
    out.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "CARGO_ZIGBUILD_ZIG_PATH": zig_binary()}
    cmd = [cargo_zigbuild_binary(), "zigbuild", "--release", "--target", f"{TARGET}.{PROXY_GLIBC}", "-p", "iara-s3-proxy"]
    log("building the S3 proxy for Linux")
    subprocess.run(cmd, cwd=repo_root(), env=env, check=True)
    built = repo_root() / "target" / TARGET / "release" / "iara-s3-proxy"
    if not built.exists():
        raise SystemExit(f"cargo-zigbuild produced no {built}")
    binary = out / PROXY_NAME
    shutil.copyfile(built, binary)
    return binary


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


def put(s3: Any, bucket: str, prefix: str, file: Path, name: str, replaces: Callable[[str], bool]) -> str:
    """Upload ``file`` as ``prefix + name``; the objects under ``prefix`` that ``replaces`` (older builds of it) are removed."""
    for o in s3.list_objects_v2(Bucket=bucket, Prefix=prefix).get("Contents", []):
        if replaces(o["Key"].removeprefix(prefix)):
            s3.delete_object(Bucket=bucket, Key=o["Key"])
    key = prefix + name
    s3.upload_file(str(file), bucket, key)
    url = f"s3://{bucket}/{key}"
    log(f"published {url} ({file.stat().st_size / 1e6:.1f} MB)")
    return url


def upload(sess: Any, wheel: Path, version: str, proxy: Path | None = None) -> str:
    """Upload the wheel as the engine of ``version`` (older builds of it are removed), and the
    proxy binary next to it (``PROXY_NAME``). Returns the wheel's URL."""
    s3 = sess.client("s3")
    bucket = artifacts_bucket(sess)
    ensure_bucket(s3, bucket, sess.region_name)
    prefix = f"engine/{version}/"
    url = put(s3, bucket, prefix, wheel, wheel.name, lambda name: name.endswith(".whl"))
    if proxy is not None:
        put(s3, bucket, prefix, proxy, PROXY_NAME, lambda name: name == PROXY_NAME)
    return url


def publish(sess: Any, wheel: Path | None = None, proxy: Path | None = None) -> str:
    """Build (without ``wheel``: the wheel and the proxy) and upload the engine of this version.
    With a built ``wheel`` nothing is built, and the proxy is uploaded only if ``proxy`` is given."""
    import iara

    if wheel is None:
        wheel = build(repo_root() / "target" / "wheels-linux")
        proxy = proxy or build_proxy(repo_root() / "target" / "proxy-linux")
    return upload(sess, wheel, iara.__version__, proxy)
