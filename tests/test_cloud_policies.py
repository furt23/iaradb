"""The IAM documents of a team (pure functions; nothing here calls AWS)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from iara.cloud.aws import AMI_PARAM
from iara.cloud.policies import TRUST_POLICY, cluster_role_policy, studio_user_policy

ACCOUNT = "123456789012"
REGION = "eu-west-1"
BUCKET = "iara-artifacts-123456789012-eu-west-1"


def studio(team: str = "acme") -> dict[str, Any]:
    return studio_user_policy(account=ACCOUNT, region=REGION, team=team, artifacts_bucket=BUCKET, security_group_id="sg-0abc")


def by_sid(policy: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {s["Sid"]: s for s in policy["Statement"]}


def actions(policy: dict[str, Any]) -> set[str]:
    return {a for s in policy["Statement"] for a in ([s["Action"]] if isinstance(s["Action"], str) else s["Action"])}


def test_cluster_role_reads_only_the_engine_builds() -> None:
    assert cluster_role_policy(BUCKET)["Statement"] == [{"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": f"arn:aws:s3:::{BUCKET}/engine/*"}]


def test_cluster_role_trusts_ec2_only() -> None:
    assert TRUST_POLICY["Statement"] == [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]


def test_studio_policy_fits_a_managed_policy_for_the_longest_names() -> None:
    longest = studio_user_policy(
        account=ACCOUNT, region="ap-southeast-2", team="x" * 31, artifacts_bucket=f"iara-artifacts-{ACCOUNT}-ap-southeast-2", security_group_id="sg-0123456789abcdef0"
    )
    compact = json.dumps(longest, separators=(",", ":"))
    assert json.loads(compact)["Version"] == "2012-10-17"
    assert len(compact) < 6144  # managed policies: 6,144 characters, whitespace excluded (inline user policies only 2,048)


def test_studio_policy_never_creates_or_changes_iam_or_buckets() -> None:
    allowed = actions(studio())
    iam = {a for a in allowed if a.startswith("iam:")}
    assert iam == {"iam:PassRole", "iam:GetInstanceProfile"}
    for forbidden in ("iam:CreateRole", "iam:PutRolePolicy", "iam:CreateInstanceProfile", "iam:AttachRolePolicy", "iam:CreateUser", "iam:CreateAccessKey"):
        assert forbidden not in allowed
    assert not {a for a in allowed if a.startswith("s3:")} - {"s3:ListBucket"}
    assert "ec2:CreateSecurityGroup" not in allowed and "ec2:DeleteSecurityGroup" not in allowed
    assert all("*" not in a for a in allowed)  # no action wildcards


def test_wide_instance_resources_carry_a_team_condition() -> None:
    # statements with a wide resource ("instance/*" and so on) must carry a team condition
    for s in studio()["Statement"]:
        resources = [s["Resource"]] if isinstance(s["Resource"], str) else s["Resource"]
        if any(r.endswith("/*") and ":instance/" in r for r in resources) and s["Action"] != "ec2:CreateTags":
            assert "acme" in json.dumps(s["Condition"])


def test_machines_must_be_launched_with_the_team_tag() -> None:
    s = by_sid(studio())["LaunchTeamMachines"]
    assert s["Action"] == "ec2:RunInstances"
    assert s["Resource"] == [
        f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/*",
        f"arn:aws:ec2:{REGION}:{ACCOUNT}:volume/*",
        f"arn:aws:ec2:{REGION}:{ACCOUNT}:network-interface/*",
    ]
    assert s["Condition"] == {"StringEquals": {"aws:RequestTag/iara:team": "acme"}}


def test_launch_uses_the_team_security_group_only() -> None:
    s = by_sid(studio())["LaunchInto"]
    assert f"arn:aws:ec2:{REGION}:{ACCOUNT}:security-group/sg-0abc" in s["Resource"]
    assert not any("security-group/*" in r for r in s["Resource"])
    assert "Condition" not in s


def test_images_must_be_amazons() -> None:
    s = by_sid(studio())["LaunchAmazonImages"]
    assert s["Resource"] == f"arn:aws:ec2:{REGION}::image/*"
    assert s["Condition"] == {"StringEquals": {"ec2:Owner": "amazon"}}


def test_tags_are_only_created_by_a_launch() -> None:
    s = by_sid(studio())["TagOnLaunch"]
    assert s["Action"] == "ec2:CreateTags"
    assert s["Condition"] == {"StringEquals": {"ec2:CreateAction": "RunInstances"}}
    assert all(":instance/" in r or ":volume/" in r or ":network-interface/" in r for r in s["Resource"])


def test_only_the_teams_machines_can_be_terminated() -> None:
    s = by_sid(studio())["EndTeamMachines"]
    assert s["Action"] == "ec2:TerminateInstances"
    assert s["Condition"] == {"StringEquals": {"aws:ResourceTag/iara:team": "acme"}}
    assert "ec2:StopInstances" not in actions(studio())


def test_firewall_changes_are_for_the_team_group_only() -> None:
    s = by_sid(studio())["TeamFirewall"]
    assert s["Action"] == ["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress"]
    assert s["Resource"] == f"arn:aws:ec2:{REGION}:{ACCOUNT}:security-group/sg-0abc"


def test_describe_calls_are_the_three_the_studio_makes() -> None:
    s = by_sid(studio())["Describe"]
    assert s["Resource"] == "*"
    assert s["Action"] == ["ec2:DescribeInstances", "ec2:DescribeSecurityGroups", "ec2:DescribeVpcs"]


def test_only_the_team_role_can_be_passed_and_only_to_ec2() -> None:
    sid = by_sid(studio())
    assert sid["PassTeamRole"]["Action"] == "iam:PassRole"
    assert sid["PassTeamRole"]["Resource"] == f"arn:aws:iam::{ACCOUNT}:role/iara/iara-cluster-acme"
    assert sid["PassTeamRole"]["Condition"] == {"StringEquals": {"iam:PassedToService": "ec2.amazonaws.com"}}
    assert sid["FindTeamProfile"]["Resource"] == f"arn:aws:iam::{ACCOUNT}:instance-profile/iara/iara-cluster-acme"


def test_ssm_is_limited_to_the_image_parameter() -> None:
    s = by_sid(studio())["ReadImageParameter"]
    assert s["Action"] == "ssm:GetParameter"
    assert s["Resource"] == f"arn:aws:ssm:{REGION}::parameter{AMI_PARAM}"


def test_artifacts_bucket_is_listed_for_the_engine_prefix_only() -> None:
    s = by_sid(studio())["ListEngineBuilds"]
    assert s["Action"] == "s3:ListBucket"
    assert s["Resource"] == f"arn:aws:s3:::{BUCKET}"
    assert s["Condition"] == {"StringLike": {"s3:prefix": "engine/*"}}


def test_policies_of_two_teams_share_nothing_team_specific() -> None:
    a, b = json.dumps(studio("acme")), json.dumps(studio("globex"))
    assert "globex" not in a and "acme" not in b
    assert a.replace("acme", "globex") == b


@pytest.mark.parametrize("team", ["a", "x" * 31])
def test_every_valid_team_makes_a_policy(team: str) -> None:
    assert len(by_sid(studio(team))) == len(studio(team)["Statement"])  # Sids are unique
