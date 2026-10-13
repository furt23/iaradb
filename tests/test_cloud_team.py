"""Team scoping of workhouse.cloud: the team id, the per-team names and the filters.
Pure functions only; nothing here calls AWS."""

from __future__ import annotations

import pytest

from workhouse.cloud.aws import ROLE, SECURITY_GROUP, TAG_COMPONENT, TAG_TEAM, role_name, security_group_name, team_id
from workhouse.cloud.resources import owns, security_group_filters, tag_filters


@pytest.fixture()
def no_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("WORKHOUSE_TEAM", raising=False)
    return monkeypatch


def test_unset_team_is_none(no_env) -> None:
    assert team_id(None) is None


def test_empty_env_counts_as_unset(no_env) -> None:
    no_env.setenv("WORKHOUSE_TEAM", "")
    assert team_id(None) is None


def test_team_is_read_from_env(no_env) -> None:
    no_env.setenv("WORKHOUSE_TEAM", "data-eng")
    assert team_id(None) == "data-eng"


def test_argument_wins_over_env(no_env) -> None:
    no_env.setenv("WORKHOUSE_TEAM", "data-eng")
    assert team_id("ml") == "ml"


@pytest.mark.parametrize("team", ["a", "dev", "a-b-c", "0", "9-lives", "x" * 31])
def test_valid_teams(team: str) -> None:
    assert team_id(team) == team


@pytest.mark.parametrize("team", ["", "Dev", "-dev", "dev_1", "dev team", "dev.x", "dev/../x", "x" * 32, "dev\n", " dev"])
def test_invalid_team_argument_is_rejected(team: str) -> None:
    with pytest.raises(ValueError, match="invalid team id"):
        team_id(team)


def test_invalid_team_in_env_is_rejected(no_env) -> None:
    no_env.setenv("WORKHOUSE_TEAM", "Not Valid")
    with pytest.raises(ValueError, match="WORKHOUSE_TEAM"):
        team_id(None)


def test_legacy_names_without_team() -> None:
    assert security_group_name(None) == SECURITY_GROUP == "workhouse-clusters"
    assert role_name(None) == ROLE == "workhouse-cluster"


def test_team_names() -> None:
    assert security_group_name("dev") == "workhouse-clusters-dev"
    assert role_name("dev") == "workhouse-cluster-dev"


def test_longest_team_fits_iam_and_ec2_name_limits() -> None:
    assert len(role_name("x" * 31)) <= 64
    assert len(security_group_name("x" * 31)) <= 255


def test_team_names_reject_invalid_ids() -> None:
    with pytest.raises(ValueError):
        security_group_name("Dev")
    with pytest.raises(ValueError):
        role_name("")


def test_tag_filters_without_team() -> None:
    assert tag_filters(None) == [{"Name": "tag-key", "Values": [TAG_COMPONENT]}]


def test_tag_filters_with_team() -> None:
    assert tag_filters("dev") == [
        {"Name": "tag-key", "Values": [TAG_COMPONENT]},
        {"Name": f"tag:{TAG_TEAM}", "Values": ["dev"]},
    ]
    assert TAG_TEAM == "workhouse:team"


def test_security_group_filters() -> None:
    assert security_group_filters("dev") == [{"Name": "group-name", "Values": ["workhouse-clusters-dev"]}]
    assert security_group_filters(None) == [{"Name": "group-name", "Values": ["workhouse-clusters*"]}]


def test_owns_with_team_matches_only_that_team() -> None:
    assert owns("workhouse-clusters-dev", SECURITY_GROUP, "dev")
    assert not owns("workhouse-clusters", SECURITY_GROUP, "dev")
    assert not owns("workhouse-clusters-prod", SECURITY_GROUP, "dev")
    assert not owns("workhouse-cluster-dev", SECURITY_GROUP, "dev")
    assert owns("workhouse-cluster-dev", ROLE, "dev")


def test_owns_without_team_matches_legacy_and_every_team() -> None:
    assert owns("workhouse-clusters", SECURITY_GROUP, None)
    assert owns("workhouse-clusters-dev", SECURITY_GROUP, None)
    assert owns("workhouse-cluster", ROLE, None)
    assert owns("workhouse-cluster-prod", ROLE, None)
    assert not owns("workhouse-clustersX", SECURITY_GROUP, None)
    assert not owns("other-role", ROLE, None)
