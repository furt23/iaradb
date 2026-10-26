"""``team-setup`` and ``team-remove``: the AWS resources of one team's Studio,
created once with admin credentials so the Studio itself needs no permission to
create anything.

Per team: the cluster role and instance profile ``iara-cluster-<team>``, the
security group ``iara-clusters-<team>`` (no rules: the Studio opens SSH to its
own address), the IAM user ``iara-studio-<team>`` whose access key the Studio
runs with, holding the managed policy of the same name (see
``policies.studio_user_policy``), and the artifacts bucket shared by all teams. Setup is idempotent; it only creates an access key when the user
has none (or when asked for a new one)."""

from __future__ import annotations

import json
from typing import Any

from iara.cloud import policies, resources
from iara.cloud.aws import IAM_PATH, account_id, artifacts_bucket, error_code, log, role_name, security_group_name, team_tags, user_name
from iara.cloud.publish import ensure_bucket

NSE = ("NoSuchEntity",)
ROLE_POLICY = "engine-read"
MAX_POLICY_VERSIONS = 5
SG_DESCRIPTION = "Iara clusters: SSH from the Studio only"
MAX_KEYS = 2  # IAM allows two access keys per user


def _missing(fn: Any) -> bool:
    """Whether ``fn`` fails because the IAM entity does not exist."""
    try:
        fn()
        return False
    except Exception as e:  # noqa: BLE001 - botocore errors are dynamic classes
        if error_code(e) not in NSE:
            raise
        return True


def ensure_role(iam: Any, team: str, bucket: str) -> None:
    """The cluster role and its instance profile, with exactly the engine-read policy."""
    name, tags = role_name(team), team_tags(team)
    if _missing(lambda: iam.get_role(RoleName=name)):
        iam.create_role(RoleName=name, Path=IAM_PATH, AssumeRolePolicyDocument=json.dumps(policies.TRUST_POLICY), Tags=tags)
        log(f"created role {name}")
    else:
        iam.update_assume_role_policy(RoleName=name, PolicyDocument=json.dumps(policies.TRUST_POLICY))
        iam.tag_role(RoleName=name, Tags=tags)
    iam.put_role_policy(RoleName=name, PolicyName=ROLE_POLICY, PolicyDocument=json.dumps(policies.cluster_role_policy(bucket)))
    for old in iam.list_role_policies(RoleName=name)["PolicyNames"]:
        if old != ROLE_POLICY:  # e.g. the data-bucket policy older Studios wrote
            iam.delete_role_policy(RoleName=name, PolicyName=old)
            log(f"removed role policy {old}")
    found: dict[str, Any] = {}

    def lookup() -> None:
        found.update(iam.get_instance_profile(InstanceProfileName=name)["InstanceProfile"])

    if _missing(lookup):
        iam.create_instance_profile(InstanceProfileName=name, Path=IAM_PATH, Tags=tags)
        log(f"created instance profile {name}")
    if name not in [r["RoleName"] for r in found.get("Roles", [])]:
        iam.add_role_to_instance_profile(InstanceProfileName=name, RoleName=name)


def ensure_spot_role(iam: Any) -> None:
    """EC2 Spot's service-linked role (one per account). The Studio's key may not create it, so a first Spot launch fails without it."""
    try:
        iam.create_service_linked_role(AWSServiceName="spot.amazonaws.com")
        log("created the EC2 Spot service-linked role")
    except Exception as e:  # noqa: BLE001 - botocore errors are dynamic classes
        if error_code(e) not in ("InvalidInput", "EntityAlreadyExists"):  # AWS answers InvalidInput when it exists
            raise


def ensure_security_group(ec2: Any, team: str) -> str:
    """The team's security group in the default VPC; returns its id."""
    name = security_group_name(team)
    vpcs = ec2.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])["Vpcs"]
    if not vpcs:
        raise SystemExit("this region has no default VPC: the Studio launches machines into it")
    vpc = vpcs[0]["VpcId"]
    found = ec2.describe_security_groups(Filters=[{"Name": "group-name", "Values": [name]}, {"Name": "vpc-id", "Values": [vpc]}])["SecurityGroups"]
    if found:
        ec2.create_tags(Resources=[found[0]["GroupId"]], Tags=team_tags(team))
        return found[0]["GroupId"]
    made = ec2.create_security_group(
        GroupName=name,
        Description=SG_DESCRIPTION,
        VpcId=vpc,
        TagSpecifications=[{"ResourceType": "security-group", "Tags": team_tags(team)}],
    )
    log(f"created security group {made['GroupId']} ({name})")
    return made["GroupId"]


def ensure_policy(iam: Any, account: str, team: str, doc: dict[str, Any]) -> str:
    """The team's managed policy ``iara-studio-<team>`` with ``doc`` as its default version; returns its ARN.
    Rewritten only when it differs, so running setup again adds no versions."""
    name = user_name(team)
    arn = f"arn:aws:iam::{account}:policy{IAM_PATH}{name}"
    if _missing(lambda: iam.get_policy(PolicyArn=arn)):
        iam.create_policy(PolicyName=name, Path=IAM_PATH, PolicyDocument=json.dumps(doc), Tags=team_tags(team))
        log(f"created policy {name}")
        return arn
    versions = iam.list_policy_versions(PolicyArn=arn)["Versions"]
    current = next(v for v in versions if v["IsDefaultVersion"])
    if iam.get_policy_version(PolicyArn=arn, VersionId=current["VersionId"])["PolicyVersion"]["Document"] == doc:
        return arn
    if len(versions) >= MAX_POLICY_VERSIONS:
        oldest = min((v for v in versions if not v["IsDefaultVersion"]), key=lambda v: v["CreateDate"])
        iam.delete_policy_version(PolicyArn=arn, VersionId=oldest["VersionId"])
    iam.create_policy_version(PolicyArn=arn, PolicyDocument=json.dumps(doc), SetAsDefault=True)
    log(f"updated policy {name}")
    return arn


def ensure_user(iam: Any, team: str, policy_arn: str) -> str:
    """The team's Studio user with exactly the Studio policy; warns about any other permission it has."""
    user = user_name(team)
    if _missing(lambda: iam.get_user(UserName=user)):
        iam.create_user(UserName=user, Path=IAM_PATH, Tags=team_tags(team))
        log(f"created user {user}")
    else:
        iam.tag_user(UserName=user, Tags=team_tags(team))
    iam.attach_user_policy(UserName=user, PolicyArn=policy_arn)
    extra = list(iam.list_user_policies(UserName=user)["PolicyNames"])
    extra += [p["PolicyArn"] for p in iam.list_attached_user_policies(UserName=user)["AttachedPolicies"] if p["PolicyArn"] != policy_arn]
    if extra:
        log(f"WARNING: {user} has other permissions ({', '.join(extra)}): its key can do more than the Studio needs")
    return user


def new_access_key(iam: Any, user: str, *, force: bool) -> tuple[str, str] | None:
    """A new access key, only if the user has none (or ``force``); None when it kept the existing ones.
    Stops when the user already has the maximum of two keys and one more is wanted."""
    keys = iam.list_access_keys(UserName=user)["AccessKeyMetadata"]
    if keys and not force:
        log(f"{user} already has {len(keys)} access key(s): none created (--new-key creates another)")
        return None
    if len(keys) >= MAX_KEYS:
        ids = ", ".join(k["AccessKeyId"] for k in keys)
        raise SystemExit(
            f"{user} already has {MAX_KEYS} access keys ({ids}), the most AWS allows. Delete the one the Studio no longer uses "
            f"(aws iam delete-access-key --user-name {user} --access-key-id <id>) and run this again with --new-key."
        )
    made = iam.create_access_key(UserName=user)["AccessKey"]
    return made["AccessKeyId"], made["SecretAccessKey"]


def setup(sess: Any, team: str, *, new_key: bool = False) -> tuple[str, str] | None:
    """Create or update the team's resources; returns the new Studio key (id, secret), if one was made."""
    ec2, iam = sess.client("ec2"), sess.client("iam")
    bucket = artifacts_bucket(sess)
    ensure_bucket(sess.client("s3"), bucket, sess.region_name)
    ensure_role(iam, team, bucket)
    ensure_spot_role(iam)
    group = ensure_security_group(ec2, team)
    account = account_id(sess)
    doc = policies.studio_user_policy(account=account, region=sess.region_name, team=team, artifacts_bucket=bucket, security_group_id=group)
    user = ensure_user(iam, team, ensure_policy(iam, account, team, doc))
    log(f"team {team} is set up in {sess.region_name} (one region per team: the Studio policy names this region's security group)")
    return new_access_key(iam, user, force=new_key)


def remove(sess: Any, team: str) -> None:
    """Delete the team's security group, instance profile, role, Studio user (with its keys) and policy.
    Refuses while the team has machines that are not terminated."""
    running = resources.machines(sess.client("ec2"), team)
    if running:
        raise SystemExit(
            f"team {team} still has machines ({', '.join(running)}): terminate them first "
            f"(the Studio's Compute page, or `python -m iara.cloud cleanup --team {team}`), and wait until they are gone."
        )
    resources.delete_infrastructure(sess, team)
    resources.delete_users(sess, team)
