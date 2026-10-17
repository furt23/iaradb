"""Everything of Iara in an AWS account and region: listing it (``verify``)
and deleting it (``cleanup``). Found by tags and fixed names, not by any
local state.

With a team, only that team's machines, volumes, network interfaces, security
group, role, instance profile, Studio user and its policy are listed or deleted; the shared
artifacts bucket is never touched. Without a team, every team's resources and
the legacy (unscoped) names are included, and the shared bucket too.

``cleanup`` keeps the Studio users and policies (the teams' access keys belong to
them) unless asked to delete them."""

from __future__ import annotations

from typing import Any

from iara.cloud.aws import IAM_PATH, ROLE, SECURITY_GROUP, TAG_COMPONENT, TAG_TEAM, USER, artifacts_bucket, error_code, log, retry, security_group_name

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
    roles = [r for page in iam.get_paginator("list_roles").paginate(PathPrefix=IAM_PATH) for r in page["Roles"]]
    return [r["RoleName"] for r in roles if owns(r["RoleName"], ROLE, team)]


def _profiles(iam: Any, team: str | None) -> list[dict[str, Any]]:
    profiles = [p for page in iam.get_paginator("list_instance_profiles").paginate(PathPrefix=IAM_PATH) for p in page["InstanceProfiles"]]
    return [p for p in profiles if owns(p["InstanceProfileName"], ROLE, team)]


def _users(iam: Any, team: str | None) -> list[str]:
    users = [u for page in iam.get_paginator("list_users").paginate(PathPrefix=IAM_PATH) for u in page["Users"]]
    return [u["UserName"] for u in users if owns(u["UserName"], USER, team)]


def _studio_policies(iam: Any, team: str | None) -> list[dict[str, Any]]:
    policies = [p for page in iam.get_paginator("list_policies").paginate(Scope="Local", PathPrefix=IAM_PATH) for p in page["Policies"]]
    return [p for p in policies if owns(p["PolicyName"], USER, team)]


def leftovers(sess: Any, team: str | None = None) -> list[str]:
    ec2, iam, s3 = sess.client("ec2"), sess.client("iam"), sess.client("s3")
    out = [f"instance {i}" for i in machines(ec2, team)]
    out += [f"volume {v['VolumeId']}" for v in ec2.describe_volumes(Filters=tag_filters(team))["Volumes"]]
    out += [f"network interface {n['NetworkInterfaceId']}" for n in ec2.describe_network_interfaces(Filters=tag_filters(team))["NetworkInterfaces"]]
    out += [f"security group {g['GroupId']}" for g in _security_groups(ec2, team)]
    out += [f"iam role {r}" for r in _roles(iam, team)]
    out += [f"instance profile {p['InstanceProfileName']}" for p in _profiles(iam, team)]
    out += [f"iam user {u}" for u in _users(iam, team)]
    out += [f"iam policy {p['PolicyName']}" for p in _studio_policies(iam, team)]
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


def terminate_machines(sess: Any, team: str | None = None) -> None:
    ec2 = sess.client("ec2")
    ids = machines(ec2, team)
    if ids:
        ec2.terminate_instances(InstanceIds=ids)
        log(f"terminating {', '.join(ids)}")
        ec2.get_waiter("instance_terminated").wait(InstanceIds=ids, WaiterConfig={"Delay": 10, "MaxAttempts": 60})


def delete_infrastructure(sess: Any, team: str | None = None) -> None:
    """Delete the security groups, instance profiles and roles of the team (every team's without one)."""
    ec2, iam = sess.client("ec2"), sess.client("iam")
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


def delete_users(sess: Any, team: str | None = None) -> None:
    """Delete the Studio users of the team (every team's without one) with their access keys,
    and the Studio policies."""
    iam = sess.client("iam")
    for user in _users(iam, team):
        for key in iam.list_access_keys(UserName=user)["AccessKeyMetadata"]:
            iam.delete_access_key(UserName=user, AccessKeyId=key["AccessKeyId"])
        for policy in iam.list_user_policies(UserName=user)["PolicyNames"]:
            iam.delete_user_policy(UserName=user, PolicyName=policy)
        for policy in iam.list_attached_user_policies(UserName=user)["AttachedPolicies"]:
            iam.detach_user_policy(UserName=user, PolicyArn=policy["PolicyArn"])
        iam.delete_user(UserName=user)
        log(f"deleted user {user} and its access keys")
    for policy in _studio_policies(iam, team):
        arn = policy["Arn"]
        for u in iam.list_entities_for_policy(PolicyArn=arn)["PolicyUsers"]:
            iam.detach_user_policy(UserName=u["UserName"], PolicyArn=arn)
        for old in iam.list_policy_versions(PolicyArn=arn)["Versions"]:
            if not old["IsDefaultVersion"]:
                iam.delete_policy_version(PolicyArn=arn, VersionId=old["VersionId"])
        iam.delete_policy(PolicyArn=arn)
        log(f"deleted policy {policy['PolicyName']}")


def cleanup(sess: Any, team: str | None = None, users: bool = False) -> None:
    """Terminate the cluster machines (the team's, or every team's), then delete the security
    groups, instance profiles and roles of the same scope; the Studio users only with ``users``.
    Without a team, also the shared bucket."""
    if team is None:
        log("WARNING: no team given: this also removes every team's Iara resources, not only the legacy ones")
    terminate_machines(sess, team)
    delete_infrastructure(sess, team)
    if users:
        delete_users(sess, team)
    else:
        for user in _users(sess.client("iam"), team):
            log(f"kept user {user} and its policy (its access keys stay valid; --with-users deletes them)")
    if team is None:
        s3 = sess.client("s3")
        bucket = artifacts_bucket(sess)
        if any(b["Name"] == bucket for b in s3.list_buckets()["Buckets"]):
            for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket):
                keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
                if keys:
                    s3.delete_objects(Bucket=bucket, Delete={"Objects": keys, "Quiet": True})
            s3.delete_bucket(Bucket=bucket)
            log(f"deleted s3://{bucket}")
