"""iara.cloud against moto's in-process AWS: publishing the engine, and
finding and removing everything Iara created in an account."""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("boto3")
moto = pytest.importorskip("moto")

from iara.cloud import publish, resources  # noqa: E402
from iara.cloud.aws import ROLE, SECURITY_GROUP, TAG_CLUSTER, TAG_COMPONENT, artifacts_bucket, session  # noqa: E402


@pytest.fixture()
def sess(monkeypatch: pytest.MonkeyPatch):
    for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("ACCESS_KEY", "testing")
    monkeypatch.setenv("SECRET_KEY", "testing")
    monkeypatch.setattr("iara.cloud.resources.retry", lambda fn, *a, **k: fn())
    with moto.mock_aws():
        yield session("us-east-1")


def studio_resources(sess) -> str:
    """What the Studio creates: a tagged machine, the security group, the role."""
    ec2, iam = sess.client("ec2"), sess.client("iam")
    vpc = ec2.describe_vpcs()["Vpcs"][0]["VpcId"]
    tags = [{"Key": TAG_COMPONENT, "Value": "clusters"}]
    ec2.create_security_group(GroupName=SECURITY_GROUP, Description="x", VpcId=vpc, TagSpecifications=[{"ResourceType": "security-group", "Tags": tags}])
    iam.create_role(RoleName=ROLE, Path="/iara/", AssumeRolePolicyDocument="{}")
    policy = '{"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::b/*"}]}'
    iam.put_role_policy(RoleName=ROLE, PolicyName="data-access", PolicyDocument=policy)
    iam.create_instance_profile(InstanceProfileName=ROLE, Path="/iara/")
    iam.add_role_to_instance_profile(InstanceProfileName=ROLE, RoleName=ROLE)
    ami = ec2.describe_images(Owners=["amazon"])["Images"][0]["ImageId"]
    machine_tags = [{"Key": TAG_COMPONENT, "Value": "cluster"}, {"Key": TAG_CLUSTER, "Value": "c-1"}]
    run = ec2.run_instances(ImageId=ami, MinCount=1, MaxCount=1, InstanceType="m7i-flex.large", TagSpecifications=[{"ResourceType": "instance", "Tags": machine_tags}])
    return run["Instances"][0]["InstanceId"]


def test_publish_uploads_the_engine_for_its_version(sess, tmp_path: Path) -> None:
    import iara

    wheel = tmp_path / f"iara-{iara.__version__}-cp310-abi3-manylinux_2_28_x86_64.whl"
    wheel.write_bytes(b"wheel")
    first = publish.publish(sess, wheel)
    again = publish.publish(sess, wheel)
    bucket = artifacts_bucket(sess)
    assert first == again == f"s3://{bucket}/engine/{iara.__version__}/{wheel.name}"
    s3 = sess.client("s3")
    assert [o["Key"] for o in s3.list_objects_v2(Bucket=bucket)["Contents"]] == [f"engine/{iara.__version__}/{wheel.name}"]
    tags = s3.get_bucket_tagging(Bucket=bucket)["TagSet"]
    assert {"Key": TAG_COMPONENT, "Value": "clusters"} in tags


def test_publish_uploads_the_proxy_next_to_the_wheel(sess, tmp_path: Path) -> None:
    import iara

    wheel = tmp_path / f"iara-{iara.__version__}-cp310-abi3-manylinux_2_28_x86_64.whl"
    wheel.write_bytes(b"wheel")
    proxy = tmp_path / "built-proxy"
    proxy.write_bytes(b"proxy")
    publish.publish(sess, wheel, proxy)
    publish.publish(sess, wheel, proxy)
    s3, bucket = sess.client("s3"), artifacts_bucket(sess)
    prefix = f"engine/{iara.__version__}/"
    # the name is the one the boot script downloads (userData.ts: proxyUrlOf), whatever the file is called here
    assert sorted(o["Key"] for o in s3.list_objects_v2(Bucket=bucket)["Contents"]) == sorted([prefix + "iara-s3-proxy-x86_64", prefix + wheel.name])
    assert s3.get_object(Bucket=bucket, Key=prefix + "iara-s3-proxy-x86_64")["Body"].read() == b"proxy"
    # publishing a wheel alone leaves the proxy where it is
    newer = tmp_path / f"iara-{iara.__version__}-cp311-abi3-manylinux_2_28_x86_64.whl"
    newer.write_bytes(b"newer")
    publish.publish(sess, newer)
    assert sorted(o["Key"] for o in s3.list_objects_v2(Bucket=bucket)["Contents"]) == sorted([prefix + "iara-s3-proxy-x86_64", prefix + newer.name])


def test_cleanup_removes_everything(sess, tmp_path: Path) -> None:
    wheel = tmp_path / "iara-0.1.0-cp310-abi3-manylinux_2_28_x86_64.whl"
    wheel.write_bytes(b"wheel")
    publish.publish(sess, wheel)
    machine = studio_resources(sess)
    left = resources.leftovers(sess)
    assert f"instance {machine}" in left and any(x.startswith("security group") for x in left)
    assert f"iam role {ROLE}" in left and f"bucket {artifacts_bucket(sess)}" in left
    resources.cleanup(sess)
    assert resources.leftovers(sess) == []


def test_zig_is_found_in_the_ziglang_package() -> None:
    pytest.importorskip("ziglang")
    assert Path(publish.zig_binary()).exists()
