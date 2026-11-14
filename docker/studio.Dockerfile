# syntax=docker/dockerfile:1
#
# Iara Studio: the Next.js web app, the engine as a Python wheel, and the
# Python kernels the Studio starts for queries and notebooks.
# Build from the repository root: docker compose build studio-default
#
# Settings come from the container environment (docker/studio-default.env, see
# docker/studio.env.example). Sign-in is on by default (IARA_AUTH=auth0):
# without the Auth0 settings the Studio answers 503 instead of serving pages.

ARG UV_VERSION=0.9.5
ARG PYTHON_VERSION=3.12

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

# ---------------------------------------------------------------------------
# wheel: the engine (iara-core and the iara-python extension), for Linux
# ---------------------------------------------------------------------------
FROM rust:1-bookworm AS wheel
COPY --from=uv /uv /uvx /usr/local/bin/
ARG PYTHON_VERSION
ENV UV_PYTHON_INSTALL_DIR=/opt/python
RUN uv python install ${PYTHON_VERSION} \
 && uv venv /opt/build --python ${PYTHON_VERSION} \
 && uv pip install --python /opt/build/bin/python maturin==1.15.0
ENV VIRTUAL_ENV=/opt/build \
    PATH=/opt/build/bin:${PATH}

WORKDIR /src
# only what maturin reads: the manifests, the Rust crates and the Python package
COPY Cargo.toml Cargo.lock pyproject.toml README.md LICENSE ./
COPY crates ./crates
COPY python ./python
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    maturin build --release --locked --out /wheels \
 && ls -l /wheels

# ---------------------------------------------------------------------------
# web: install the pnpm workspace and build the Studio
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS web
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# manifests first, so the install layer is reused until dependencies change;
# pnpm reads every workspace manifest, so all of them are copied
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/docs/package.json apps/docs/
COPY apps/site/package.json apps/site/
COPY packages/protocol/package.json packages/protocol/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @iara/web...

COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter @iara/web build

# ---------------------------------------------------------------------------
# final: the Studio at run time, with Python, git and ssh (kernels and clusters)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS final
ARG PYTHON_VERSION
ENV UV_PYTHON_INSTALL_DIR=/opt/python
COPY --from=uv /uv /uvx /usr/local/bin/

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client tini \
 && rm -rf /var/lib/apt/lists/*

# Python for the kernels, in /opt/venv. The engine's wheel is built for abi3, and
# its pinned companions are the versions in uv.lock (marimo and jedi for notebooks
# and completion, boto3 for S3 and clusters).
RUN uv python install ${PYTHON_VERSION} \
 && uv venv /opt/venv --python ${PYTHON_VERSION}
RUN --mount=type=bind,from=wheel,source=/wheels,target=/wheels \
    --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python \
      /wheels/iaradb-*.whl \
      "pyarrow==25.0.1" "marimo==0.25.1" "jedi==0.20.0" "boto3==1.43.111"

# the built workspace: the web app with the node_modules it needs at run time
COPY --from=web /app /app

RUN groupadd --gid 10001 studio \
 && useradd --uid 10001 --gid studio --home-dir /home/studio --create-home --shell /usr/sbin/nologin studio \
 && mkdir -p /workspace /data /app/apps/web/.next/cache \
 && chown -R studio:studio /workspace /data /app/apps/web/.next

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    IARA_AUTH=auth0 \
    IARA_WORKSPACE=/workspace \
    IARA_STUDIO_DATA=/data \
    IARA_PYTHON=/opt/venv/bin/python

USER studio
WORKDIR /app/apps/web
VOLUME ["/workspace", "/data"]
EXPOSE 3870

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3870/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3870"]
