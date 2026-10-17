"""``team-setup`` / ``team-remove`` and the team-aware ``verify`` / ``cleanup``,
against moto's in-process AWS (no real AWS is called)."""

from __future__ import annotations

import pytest

pytest.importorskip("boto3")
moto = pytest.importorskip("moto")

from iara.cloud import policies, resources, team  # noqa: E402
from iara.cloud.__main__ import main  # noqa: E402
from iara.cloud.aws import AMI_PARAM, TAG_COMPONENT, TAG_TEAM, artifacts_bucket, role_name, security_group_name, session, user_name  # noqa: E402


@pytest.fixture()
def sess(monkeypatch: pytest.MonkeyPatch):
    for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "IARA_TEAM"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("ACCESS_KEY", "testing")
    monkeypatch.setenv("SECRET_KEY", "testing")
    monkeypatch.setattr("iara.cloud.resources.retry", lambda fn, *a, **k: fn())
    with moto.mock_aws():
        yield session("us-east-1")


def launch(sess, team_name: str) -> str:
    """A machine tagged as the Studio of ``team_name`` tags its own."""
    ec2 = sess.client("ec2")
    ami = ec2.describe_images(Owners=["amazon"])["Images"][0]["ImageId"]
    tags = [{"Key": TAG_COMPONENT, "Value": "cluster"}, {"Key": TAG_TEAM, "Value": team_name}]
    run = ec2.run_instances(ImageId=ami, MinCount=1, MaxCount=1, InstanceType="m7i-flex.large", TagSpecifications=[{"ResourceType": "instance", "Tags": tags}])
    return run["Instances"][0]["InstanceId"]


def studio_policy_document(sess, team_name: str) -> dict:
    iam = sess.client("iam")
    arn = f"arn:aws:iam::{sess.client('sts').get_caller_identity()['Account']}:policy/iara/{user_name(team_name)}"
    version = iam.get_policy(PolicyArn=arn)["Policy"]["DefaultVersionId"]
    return iam.get_policy_version(PolicyArn=arn, VersionId=version)["PolicyVersion"]["Document"]


def test_setup_creates_the_team_resources_and_a_key(sess) -> None:
    key = team.setup(sess, "acme")
    assert key is not None and key[0] and key[1]
    iam, ec2, s3 = sess.client("iam"), sess.client("ec2"), sess.client("s3")
    bucket = artifacts_bucket(sess)
    assert bucket in [b["Name"] for b in s3.list_buckets()["Buckets"]]
    role = iam.get_role(RoleName=role_name("acme"))["Role"]
    assert role["Path"] == "/iara/" and role["AssumeRolePolicyDocument"] == policies.TRUST_POLICY
    assert iam.list_role_policies(RoleName=role_name("acme"))["PolicyNames"] == ["engine-read"]
    doc = iam.get_role_policy(RoleName=role_name("acme"), PolicyName="engine-read")["PolicyDocument"]
    assert doc == policies.cluster_role_policy(bucket)
    profile = iam.get_instance_profile(InstanceProfileName=role_name("acme"))["InstanceProfile"]
    assert [r["RoleName"] for r in profile["Roles"]] == [role_name("acme")]
    groups = ec2.describe_security_groups(Filters=[{"Name": "group-name", "Values": [security_group_name("acme")]}])["SecurityGroups"]
    assert len(groups) == 1 and not [p for p in groups[0]["IpPermissions"] if p["FromPort"] == 22]
    assert {"Key": TAG_TEAM, "Value": "acme"} in groups[0]["Tags"]
    assert iam.get_user(UserName="iara-studio-acme")["User"]["Path"] == "/iara/"


def test_the_studio_user_holds_exactly_the_generated_policy(sess) -> None:
    team.setup(sess, "acme")
    iam, ec2 = sess.client("iam"), sess.client("ec2")
    group = ec2.describe_security_groups(Filters=[{"Name": "group-name", "Values": ["iara-clusters-acme"]}])["SecurityGroups"][0]["GroupId"]
    account = sess.client("sts").get_caller_identity()["Account"]
    expected = policies.studio_user_policy(account=account, region="us-east-1", team="acme", artifacts_bucket=artifacts_bucket(sess), security_group_id=group)
    assert studio_policy_document(sess, "acme") == expected
    assert iam.list_user_policies(UserName="iara-studio-acme")["PolicyNames"] == []
    attached = iam.list_attached_user_policies(UserName="iara-studio-acme")["AttachedPolicies"]
    assert [p["PolicyName"] for p in attached] == ["iara-studio-acme"]
    assert AMI_PARAM in str(expected)


def test_setup_twice_changes_nothing_and_makes_no_second_key(sess) -> None:
    team.setup(sess, "acme")
    iam = sess.client("iam")
    before = iam.list_access_keys(UserName="iara-studio-acme")["AccessKeyMetadata"]
    assert team.setup(sess, "acme") is None
    assert iam.list_access_keys(UserName="iara-studio-acme")["AccessKeyMetadata"] == before
    arn = f"arn:aws:iam::{sess.client('sts').get_caller_identity()['Account']}:policy/iara/iara-studio-acme"
    assert len(iam.list_policy_versions(PolicyArn=arn)["Versions"]) == 1
    assert len(sess.client("ec2").describe_security_groups(Filters=[{"Name": "group-name", "Values": ["iara-clusters-acme"]}])["SecurityGroups"]) == 1


def test_setup_replaces_the_policies_older_studios_wrote(sess) -> None:
    team.setup(sess, "acme")
    iam = sess.client("iam")
    iam.put_role_policy(RoleName=role_name("acme"), PolicyName="data-access", PolicyDocument='{"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:*", "Resource": "*"}]}')
    team.setup(sess, "acme")
    assert iam.list_role_policies(RoleName=role_name("acme"))["PolicyNames"] == ["engine-read"]


def test_setup_updates_a_stale_studio_policy(sess) -> None:
    team.setup(sess, "acme")
    iam = sess.client("iam")
    arn = f"arn:aws:iam::{sess.client('sts').get_caller_identity()['Account']}:policy/iara/iara-studio-acme"
    iam.create_policy_version(PolicyArn=arn, PolicyDocument='{"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "ec2:*", "Resource": "*"}]}', SetAsDefault=True)
    team.setup(sess, "acme")
    assert "ec2:*" not in str(studio_policy_document(sess, "acme"))
    assert len(iam.list_policy_versions(PolicyArn=arn)["Versions"]) <= 5


def test_new_key_adds_a_second_and_a_third_stops(sess) -> None:
    first = team.setup(sess, "acme")
    second = team.setup(sess, "acme", new_key=True)
    assert first is not None and second is not None and first[0] != second[0]
    with pytest.raises(SystemExit, match="already has 2 access keys"):
        team.setup(sess, "acme", new_key=True)
    assert len(sess.client("iam").list_access_keys(UserName="iara-studio-acme")["AccessKeyMetadata"]) == 2


def test_setup_warns_about_other_permissions_on_the_user(sess, capsys: pytest.CaptureFixture[str]) -> None:
    team.setup(sess, "acme")
    sess.client("iam").put_user_policy(UserName="iara-studio-acme", PolicyName="extra", PolicyDocument='{"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}')
    team.setup(sess, "acme")
    assert "WARNING: iara-studio-acme has other permissions (extra)" in capsys.readouterr().err


def test_teams_are_separate(sess) -> None:
    team.setup(sess, "acme")
    team.setup(sess, "globex")
    assert "globex" not in str(studio_policy_document(sess, "acme"))
    assert resources.leftovers(sess, "acme") != resources.leftovers(sess, "globex")
    assert all("globex" not in x for x in resources.leftovers(sess, "acme"))


def test_cli_prints_only_the_two_env_lines_on_stdout(sess, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["team-setup", "acme"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert len(out) == 2
    assert out[0].startswith("IARA_AWS_ACCESS_KEY_ID=") and out[1].startswith("IARA_AWS_SECRET_ACCESS_KEY=")
    assert main(["team-setup", "acme"]) == 0
    assert capsys.readouterr().out == ""  # the user already has a key


def test_cli_rejects_an_invalid_team(sess) -> None:
    with pytest.raises(SystemExit, match="invalid team id"):
        main(["team-setup", "Not Valid"])


def test_remove_refuses_while_machines_run(sess) -> None:
    team.setup(sess, "acme")
    machine = launch(sess, "acme")
    with pytest.raises(SystemExit, match=machine):
        team.remove(sess, "acme")
    assert resources.leftovers(sess, "acme")  # nothing was deleted


def test_remove_deletes_the_team_and_only_the_team(sess) -> None:
    team.setup(sess, "acme")
    team.setup(sess, "globex")
    team.remove(sess, "acme")
    assert resources.leftovers(sess, "acme") == []
    left = resources.leftovers(sess, "globex")
    assert "iam user iara-studio-globex" in left and "iam policy iara-studio-globex" in left and "iam role iara-cluster-globex" in left


def test_remove_after_machines_ended(sess) -> None:
    team.setup(sess, "acme")
    machine = launch(sess, "acme")
    sess.client("ec2").terminate_instances(InstanceIds=[machine])
    team.remove(sess, "acme")
    assert not [x for x in resources.leftovers(sess, "acme") if x.startswith(("iam", "security group", "instance profile"))]


def test_verify_lists_users_and_policies_and_cleanup_keeps_them(sess) -> None:
    team.setup(sess, "acme")
    machine = launch(sess, "acme")
    assert "iam user iara-studio-acme" in resources.leftovers(sess, "acme")
    resources.cleanup(sess, "acme")
    left = resources.leftovers(sess, "acme")
    assert f"instance {machine}" not in left
    assert left == ["iam user iara-studio-acme", "iam policy iara-studio-acme"]
    assert len(sess.client("iam").list_access_keys(UserName="iara-studio-acme")["AccessKeyMetadata"]) == 1


def test_cleanup_with_users_deletes_them_and_their_keys(sess) -> None:
    team.setup(sess, "acme")
    team.setup(sess, "globex")
    resources.cleanup(sess, "acme", users=True)
    assert resources.leftovers(sess, "acme") == []
    assert "iam user iara-studio-globex" in resources.leftovers(sess, "globex")


def test_cleanup_of_every_team_removes_the_bucket_but_not_users_unasked(sess) -> None:
    team.setup(sess, "acme")
    resources.cleanup(sess)
    assert resources.leftovers(sess) == ["iam user iara-studio-acme", "iam policy iara-studio-acme"]
    resources.cleanup(sess, users=True)
    assert resources.leftovers(sess) == []


def test_cli_commands_end_to_end(sess, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["team-setup", "acme"]) == 0
    assert main(["verify", "--team", "acme"]) == 1
    assert "LEFT: iam user iara-studio-acme" in capsys.readouterr().out
    assert main(["cleanup", "--yes", "--team", "acme"]) == 0  # role, group and profile go; the user stays
    assert main(["verify", "--team", "acme"]) == 1
    assert main(["team-remove", "acme", "--yes"]) == 0
    assert main(["verify", "--team", "acme"]) == 0
