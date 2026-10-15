# syntax=docker/dockerfile:1
#
# The landing site (Astro), served as static files by nginx.
# Build from the repository root: docker compose build site

# ---------------------------------------------------------------------------
# build: install the workspace (for its lockfile) and build the landing site
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# manifests first, so the install layer is reused until dependencies change;
# pnpm reads every workspace manifest, so all of them are copied
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/docs/package.json apps/docs/
COPY apps/site/package.json apps/site/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @iara/site...

COPY apps/site apps/site
RUN pnpm --filter @iara/site build

# ---------------------------------------------------------------------------
# final: static files on unprivileged nginx (listens on 8080, runs as uid 101)
# ---------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS final
COPY docker/docs.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/site/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
