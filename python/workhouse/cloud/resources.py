"""Everything of Workhouse in an AWS account and region: listing it (``verify``)
and deleting it (``cleanup``). Found by tags and fixed names, not by any
local state."""

from __future__ import annotations

from typing import Any

from workhouse.cloud.aws import ROLE, SECURITY_GROUP, TAG_COMPONENT, artifacts_bucket, error_code, log, retry


def _tagged(cfg_filter: str = TAG_COMPONENT) -> list[dict[str, Any]]:
    return [{"Name": "tag-key", "Values": [cfg_filter]}]


def machines(ec2: Any) -> list[str]:
    """Cluster machines not terminated yet."""
    res = ec2.describe_instances(Filters=_tagged())["Reservations"]
    return [i["InstanceId"] for r in res for i in r["Instances"] if i["State"]["Name"] != "terminated"]


def leftovers(sess: Any) -> list[str]:
    ec2, iam, s3 = sess.client("ec2"), sess.client("iam"), sess.client("s3")
    out = [f"instance {i}" for i in machines(ec2)]
    out += [f"volume {v['VolumeId']}" for v in ec2.describe_volumes(Filters=_tagged())["Volumes"]]
    out += [f"network interface {n['NetworkInterfaceId']}" for n in ec2.describe_network_interfaces(Filters=_tagged())["NetworkInterfaces"]]
    out += [f"security group {g['GroupId']}" for g in ec2.describe_security_groups(Filters=[{"Name": "group-name", "Values": [SECURITY_GROUP]}])["SecurityGroups"]]
    out += [f"iam role {r['RoleName']}" for r in iam.list_roles(PathPrefix="/workhouse/")["Roles"]]
    out += [f"instance profile {p['InstanceProfileName']}" for p in iam.list_instance_profiles(PathPrefix="/workhouse/")["InstanceProfiles"]]
    bucket = artifacts_bucket(sess)
    out += [f"bucket {b['Name']}" for b in s3.list_buckets()["Buckets"] if b["Name"] == bucket]
    return out


def _ignore(codes: tuple[str, ...], fn: Any) -> None:
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        if error_code(e) not in codes:
            raise


def cleanup(sess: Any) -> None:
    """Terminate every cluster machine, then delete the shared resources."""
    ec2, iam, s3 = sess.client("ec2"), sess.client("iam"), sess.client("s3")
    ids = machines(ec2)
    if ids:
        ec2.terminate_instances(InstanceIds=ids)
        log(f"terminating {', '.join(ids)}")
        ec2.get_waiter("instance_terminated").wait(InstanceIds=ids, WaiterConfig={"Delay": 10, "MaxAttempts": 60})
    for g in ec2.describe_security_groups(Filters=[{"Name": "group-name", "Values": [SECURITY_GROUP]}])["SecurityGroups"]:
        retry(lambda gid=g["GroupId"]: ec2.delete_security_group(GroupId=gid), ("DependencyViolation",), attempts=40)
        log(f"deleted security group {g['GroupId']}")
    nse = ("NoSuchEntity",)
    _ignore(nse, lambda: iam.remove_role_from_instance_profile(InstanceProfileName=ROLE, RoleName=ROLE))
    _ignore(nse, lambda: iam.delete_instance_profile(InstanceProfileName=ROLE))
    if _role_exists(iam):
        for p in iam.list_role_policies(RoleName=ROLE).get("PolicyNames", []):
            iam.delete_role_policy(RoleName=ROLE, PolicyName=p)
    _ignore(nse, lambda: iam.delete_role(RoleName=ROLE))
    log(f"deleted role and instance profile {ROLE}")
    bucket = artifacts_bucket(sess)
    if any(b["Name"] == bucket for b in s3.list_buckets()["Buckets"]):
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket):
            keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if keys:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": keys, "Quiet": True})
        s3.delete_bucket(Bucket=bucket)
        log(f"deleted s3://{bucket}")


def _role_exists(iam: Any) -> bool:
    try:
        iam.get_role(RoleName=ROLE)
        return True
    except Exception as e:  # noqa: BLE001
        if error_code(e) == "NoSuchEntity":
            return False
        raise
