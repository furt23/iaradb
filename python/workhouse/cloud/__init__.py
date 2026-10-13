"""Administration of the AWS side of Workhouse Studio's clusters.

Clusters themselves are created, started and terminated by the Studio (its
Compute page). This module covers what happens outside the Studio:

    uv run --env-file .aws python -m workhouse.cloud publish   # build the engine for Linux, upload it for clusters
    uv run --env-file .aws python -m workhouse.cloud verify    # anything of Workhouse left in the account? (exit 1 if so)
    uv run --env-file .aws python -m workhouse.cloud cleanup --yes   # terminate machines, delete shared resources

``--team <id>`` (or env ``WORKHOUSE_TEAM``) limits ``verify`` and ``cleanup`` to one
team's resources; without it they cover every team and the legacy names.

Credentials come from the environment: ``AWS_ACCESS_KEY_ID`` /
``AWS_SECRET_ACCESS_KEY`` (or ``ACCESS_KEY`` / ``SECRET_KEY``).
"""
