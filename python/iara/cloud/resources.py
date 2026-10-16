"""Everything of Iara in an AWS account and region: listing it (``verify``)
and deleting it (``cleanup``). Found by tags and fixed names, not by any
local state.

With a team, only that team's machines, volumes, network interfaces, security
group, role and instance profile are listed or deleted; the shared artifacts
bucket is never touched. Without a team, every team's resources and the legacy
(unscoped) names are included, and the shared bucket too."""

from __future__ import annotations

from typing import Any

from iara.cloud.aws import ROLE, SECURITY_GROUP, TAG_COMPONENT, TAG_TEAM, artifacts_bucket, error_code, log, retry, security_group_name

PATH = "/iara/"
NSE = ("NoSuchEntity",)


def tag_filters(team: str | None = None) -> list[dict[str, Any]]:
    """EC2 filters for what Iara tagged: everything, or only the team's."""
    filters: list[dict[str, Any]] = [{"Name": "tag-key", "Values": [TAG_COMPONENT]}]
    if team is not None:
        filters.append({"Name": f"tag:{TAG_TEAM}", "Values": [team]})
    return filters


def security_group_filters(team: str | None = None) -> list[dict[str, Any]]:
    """EC2 filters for the security groups by name: the team's one, or without a team the
    legacy one and every team's (narrowed further by ``owns``)."""
    if team is None:
        return [{"Name": "group-name", "Values": [f"{SECURITY_GROUP}*"]}]
    return [{"Name": "group-name", "Values": [security_group_name(team)]}]


def owns(name: str, legacy: str, team: str | None) -> bool:
    """Whether an IAM or security group ``name`` belongs to ``team``. Without a team: the
    legacy name or any team's (``<legacy>-<team>``)."""
    if team is not None:
        return name == f"{legacy}-{team}"
    return name == legacy or name.startswith(legacy + "-")


def machines(ec2: Any, team: str | None = None) -> list[str]:
    """Cluster machines not terminated yet."""
    res = ec2.describe_instances(Filters=tag_filters(team))["Reservations"]
    return [i["InstanceId"] for r in res for i in r["Instances"] if i["State"]["Name"] != "terminated"]


def _security_groups(ec2: Any, team: str | None) -> list[dict[str, Any]]:
    groups = ec2.describe_security_groups(Filters=security_group_filters(team))["SecurityGroups"]
    return [g for g in groups if owns(g["GroupName"], SECURITY_GROUP, team)]


def _roles(iam: Any, team: str | None) -> list[str]:
    roles = [r for page in iam.get_paginator("list_roles").paginate(PathPrefix=PATH) for r in page["Roles"]]
    return [r["RoleName"] for r in roles if owns(r["RoleName"], ROLE, team)]


def _profiles(iam: Any, team: str | None) -> list[dict[str, Any]]:
    profiles = [p for page in iam.get_paginator("list_instance_profiles").paginate(PathPrefix=PATH) for p in page["InstanceProfiles"]]
    return [p for p in profiles if owns(p["InstanceProfileName"], ROLE, team)]


def leftovers(sess: Any, team: str | None = None) -> list[str]:
    ec2, iam, s3 = sess.client("ec2"), sess.client("iam"), sess.client("s3")
    out = [f"instance {i}" for i in machines(ec2, team)]
    out += [f"volume {v['VolumeId']}" for v in ec2.describe_volumes(Filters=tag_filters(team))["Volumes"]]
    out += [f"network interface {n['NetworkInterfaceId']}" for n in ec2.describe_network_interfaces(Filters=tag_filters(team))["NetworkInterfaces"]]
    out += [f"security group {g['GroupId']}" for g in _security_groups(ec2, team)]
    out += [f"iam role {r}" for r in _roles(iam, team)]
    out += [f"instance profile {p['InstanceProfileName']}" for p in _profiles(iam, team)]
    if team is None:
        bucket = artifacts_bucket(sess)
        out += [f"bucket {b['Name']}" for b in s3.list_buckets()["Buckets"] if b["Name"] == bucket]
    return out


def _ignore(codes: tuple[str, ...], fn: Any) -> None:
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        if error_code(e) not in codes:
            raise


def cleanup(sess: Any, team: str | None = None) -> None:
    """Terminate the cluster machines (the team's, or every team's), then delete the security
    groups, instance profiles and roles of the same scope. Without a team, also the shared bucket."""
    if team is None:
        log("WARNING: no team given: this also removes every team's Iara resources, not only the legacy ones")
    ec2, iam, s3 = sess.client("ec2"), sess.client("iam"), sess.client("s3")
    ids = machines(ec2, team)
    if ids:
        ec2.terminate_instances(InstanceIds=ids)
        log(f"terminating {', '.join(ids)}")
        ec2.get_waiter("instance_terminated").wait(InstanceIds=ids, WaiterConfig={"Delay": 10, "MaxAttempts": 60})
    for g in _security_groups(ec2, team):
        retry(lambda gid=g["GroupId"]: ec2.delete_security_group(GroupId=gid), ("DependencyViolation",), attempts=40)
        log(f"deleted security group {g['GroupId']}")
    for p in _profiles(iam, team):
        pname = p["InstanceProfileName"]
        for r in p.get("Roles", []):
            _ignore(NSE, lambda rn=r["RoleName"]: iam.remove_role_from_instance_profile(InstanceProfileName=pname, RoleName=rn))
        _ignore(NSE, lambda: iam.delete_instance_profile(InstanceProfileName=pname))
        log(f"deleted instance profile {pname}")
    for role in _roles(iam, team):
        for policy in iam.list_role_policies(RoleName=role).get("PolicyNames", []):
            _ignore(NSE, lambda pn=policy: iam.delete_role_policy(RoleName=role, PolicyName=pn))
        _ignore(NSE, lambda: iam.delete_role(RoleName=role))
        log(f"deleted role {role}")
    if team is None:
        bucket = artifacts_bucket(sess)
        if any(b["Name"] == bucket for b in s3.list_buckets()["Buckets"]):
            for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket):
                keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
                if keys:
                    s3.delete_objects(Bucket=bucket, Delete={"Objects": keys, "Quiet": True})
            s3.delete_bucket(Bucket=bucket)
            log(f"deleted s3://{bucket}")
