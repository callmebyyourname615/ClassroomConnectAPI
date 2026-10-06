# syntax=docker/dockerfile:1
# Override NODE_IMAGE with a tested tag@sha256:digest in CI for immutable releases.
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
    && test -f dist/main.js \
    && test -f dist/database/data-source.js

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS production
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade perl-base \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && mkdir -p uploads logs \
    && chown node:node uploads logs
USER node
# API main.ts still binds 127.0.0.1. Run with --network host on Linux.
# Set PORT and school-specific credentials at runtime; no secrets baked in.
CMD ["node", "dist/main.js"]
