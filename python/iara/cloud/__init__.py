"""Administration of the AWS side of Iara Studio's clusters.

Clusters themselves are created, started and terminated by the Studio (its
Compute page). This module covers what happens outside the Studio:

    uv run --env-file .aws python -m iara.cloud publish   # build the engine for Linux, upload it for clusters
    uv run --env-file .aws python -m iara.cloud verify    # anything of Iara left in the account? (exit 1 if so)
    uv run --env-file .aws python -m iara.cloud cleanup --yes   # terminate machines, delete shared resources

``--team <id>`` (or env ``IARA_TEAM``) limits ``verify`` and ``cleanup`` to one
team's resources; without it they cover every team and the legacy names.

Credentials come from the environment: ``AWS_ACCESS_KEY_ID`` /
``AWS_SECRET_ACCESS_KEY`` (or ``ACCESS_KEY`` / ``SECRET_KEY``).
"""
