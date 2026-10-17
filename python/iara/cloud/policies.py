"""IAM documents of a team (pure; unit tested): what its cluster machines may do,
and what its Studio's own AWS key may do.

The Studio never creates IAM resources, security groups or buckets: ``team-setup``
does, with admin credentials, and the Studio key is limited to launching and
ending *its team's* machines. Resource ARNs carry the account, region and team;
the commercial partition (``aws``) is assumed. ``sts:GetCallerIdentity``, which
the Studio also calls, needs no permission.

The Studio policy is about 2.5 KB, over the 2,048 characters IAM allows an
inline user policy, so ``team-setup`` makes it a managed policy (limit 6,144).
"""

from __future__ import annotations

from typing import Any

from iara.cloud.aws import AMI_PARAM, IAM_PATH, TAG_TEAM, role_name

VERSION = "2012-10-17"
ENGINE_PREFIX = "engine/"

TRUST_POLICY: dict[str, Any] = {
    "Version": VERSION,
    "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}],
}


def cluster_role_policy(artifacts_bucket: str) -> dict[str, Any]:
    """The machines' role: read the engine builds, nothing else (data goes through the team's store proxy)."""
    return {
        "Version": VERSION,
        "Statement": [{"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": f"arn:aws:s3:::{artifacts_bucket}/{ENGINE_PREFIX}*"}],
    }


def studio_user_policy(*, account: str, region: str, team: str, artifacts_bucket: str, security_group_id: str) -> dict[str, Any]:
    """The Studio key of ``team``: launch machines tagged with the team, end the team's machines,
    adjust the team's security group, pass the team's role to EC2, read what a launch needs. No IAM
    writes, no bucket or security group creation, no access to the data."""
    ec2 = f"arn:aws:ec2:{region}:{account}"
    role = f"arn:aws:iam::{account}:role{IAM_PATH}{role_name(team)}"
    profile = f"arn:aws:iam::{account}:instance-profile{IAM_PATH}{role_name(team)}"
    group = f"{ec2}:security-group/{security_group_id}"
    tagged = [f"{ec2}:instance/*", f"{ec2}:volume/*", f"{ec2}:network-interface/*"]
    statements: list[dict[str, Any]] = [
        {
            # the machine, its disk and its network card are created with the team tag, or not at all
            "Sid": "LaunchTeamMachines",
            "Effect": "Allow",
            "Action": "ec2:RunInstances",
            "Resource": tagged,
            "Condition": {"StringEquals": {f"aws:RequestTag/{TAG_TEAM}": team}},
        },
        {
            "Sid": "LaunchInto",
            "Effect": "Allow",
            "Action": "ec2:RunInstances",
            "Resource": [group, f"{ec2}:subnet/*", f"{ec2}:spot-instances-request/*"],
        },
        {
            # Amazon's own images only (the Studio uses Amazon Linux)
            "Sid": "LaunchAmazonImages",
            "Effect": "Allow",
            "Action": "ec2:RunInstances",
            "Resource": f"arn:aws:ec2:{region}::image/*",
            "Condition": {"StringEquals": {"ec2:Owner": "amazon"}},
        },
        {
            # tags exist only as part of a launch: a running machine's tags (its team) cannot change
            "Sid": "TagOnLaunch",
            "Effect": "Allow",
            "Action": "ec2:CreateTags",
            "Resource": tagged,
            "Condition": {"StringEquals": {"ec2:CreateAction": "RunInstances"}},
        },
        {
            "Sid": "EndTeamMachines",
            "Effect": "Allow",
            "Action": "ec2:TerminateInstances",
            "Resource": f"{ec2}:instance/*",
            "Condition": {"StringEquals": {f"aws:ResourceTag/{TAG_TEAM}": team}},
        },
        {
            # the Studio opens SSH to its own address
            "Sid": "TeamFirewall",
            "Effect": "Allow",
            "Action": ["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress"],
            "Resource": group,
        },
        {
            # these Describe calls have no resource-level permissions
            "Sid": "Describe",
            "Effect": "Allow",
            "Action": ["ec2:DescribeInstances", "ec2:DescribeSecurityGroups", "ec2:DescribeVpcs"],
            "Resource": "*",
        },
        {
            "Sid": "PassTeamRole",
            "Effect": "Allow",
            "Action": "iam:PassRole",
            "Resource": role,
            "Condition": {"StringEquals": {"iam:PassedToService": "ec2.amazonaws.com"}},
        },
        {"Sid": "FindTeamProfile", "Effect": "Allow", "Action": "iam:GetInstanceProfile", "Resource": profile},
        {"Sid": "ReadImageParameter", "Effect": "Allow", "Action": "ssm:GetParameter", "Resource": f"arn:aws:ssm:{region}::parameter{AMI_PARAM}"},
        {
            "Sid": "ListEngineBuilds",
            "Effect": "Allow",
            "Action": "s3:ListBucket",
            "Resource": f"arn:aws:s3:::{artifacts_bucket}",
            "Condition": {"StringLike": {"s3:prefix": f"{ENGINE_PREFIX}*"}},
        },
    ]
    return {"Version": VERSION, "Statement": statements}
