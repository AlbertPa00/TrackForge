# syntax=docker/dockerfile:1
# 043 — trackforge-app: single-origin image (backend serves the built frontend).
# Build from the REPO ROOT:  docker build -f apps/backend/Dockerfile -t trackforge .
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build
# openssl needed BEFORE prisma generate so it detects musl-openssl-3.x (not
# the default 1.1.x engine, which won't load on alpine 3.20+).
RUN apk add --no-cache openssl && corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
COPY apps/mcp/package.json apps/mcp/
COPY docs/package.json docs/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter backend db:generate \
 && pnpm --filter frontend build \
 && pnpm --filter trackforge-mcp build \
 && pnpm --filter backend build \
 && pnpm --filter backend deploy --prod /out \
 && cp -r apps/backend/prisma /out/prisma \
 && cd /out && ./node_modules/.bin/prisma generate --schema=./prisma/schema.prisma
# pnpm deploy --prod doesn't carry the generated client (.prisma/) — regenerate
# it inside /out so require('.prisma/client/default') resolves at runtime.

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runtime
ARG TF_VERSION=0.0.0-dev
ARG TF_BUILD_DATE
ARG TF_BUILD_NUMBER=1
ARG TF_SCM_REVISION
LABEL org.opencontainers.image.title="TrackForge" \
      org.opencontainers.image.source="https://github.com/AlbertPa00/TrackForge" \
      org.opencontainers.image.revision="${TF_SCM_REVISION}" \
      org.opencontainers.image.version="${TF_VERSION}"
ENV NODE_ENV=production \
    TF_VERSION=${TF_VERSION} \
    TF_BUILD_DATE=${TF_BUILD_DATE} \
    TF_BUILD_NUMBER=${TF_BUILD_NUMBER} \
    TF_SCM_REVISION=${TF_SCM_REVISION} \
    FRONTEND_DIST=/app/frontend-dist \
    BACKUP_DIR=/backups \
    PORT=3000
RUN addgroup -S trackforge && adduser -S trackforge -G trackforge \
 && apk add --no-cache wget openssl postgresql16-client
WORKDIR /app
COPY --from=build --chown=trackforge:trackforge /out ./
COPY --from=build --chown=trackforge:trackforge /src/apps/frontend/dist ./frontend-dist
USER trackforge
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 || exit 1
# graceful SIGTERM handled in main.ts (drain HTTP + jobs)
CMD ["node", "dist/main.js"]
