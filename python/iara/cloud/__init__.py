"""Administration of the AWS side of Iara Studio's clusters.

Clusters themselves are started and terminated by the Studio (its Compute
page), with a key that can only launch and end its own team's machines. This
module covers what happens outside the Studio, with admin credentials:

    uv run --env-file .aws python -m iara.cloud team-setup <team>   # once per team: role, security group, bucket, Studio user and key
    uv run --env-file .aws python -m iara.cloud publish             # build the engine for Linux, upload it for clusters
    uv run --env-file .aws python -m iara.cloud verify              # anything of Iara left in the account? (exit 1 if so)
    uv run --env-file .aws python -m iara.cloud cleanup --yes       # terminate machines, delete shared resources
    uv run --env-file .aws python -m iara.cloud team-remove <team>  # delete a team's resources and Studio user

``team-setup`` prints the two lines (``IARA_AWS_ACCESS_KEY_ID`` and
``IARA_AWS_SECRET_ACCESS_KEY``) for the team's ``docker/<team>.env``; they are
the team's own key, never the admin one. It is safe to run again: it updates
the policies and creates a key only for ``--new-key`` (or when the user has none).

``--team <id>`` (or env ``IARA_TEAM``) limits ``verify`` and ``cleanup`` to one
team's resources; without it they cover every team and the legacy names.
``cleanup`` keeps the Studio users unless given ``--with-users``.

Credentials come from the environment: ``AWS_ACCESS_KEY_ID`` /
``AWS_SECRET_ACCESS_KEY`` (or ``ACCESS_KEY`` / ``SECRET_KEY``).
"""
