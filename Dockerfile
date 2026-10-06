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

RUN mkdir -p /runtime/bin /runtime/uploads /runtime/logs \
    && ln -s /nodejs/bin/node /runtime/bin/node

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

FROM gcr.io/distroless/nodejs24-debian13:nonroot AS production
ENV NODE_ENV=production
ENV PATH="/usr/local/bin:/usr/bin:/bin"
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY --from=build /runtime/bin/ /usr/local/bin/
COPY --from=build --chown=1000:1000 /runtime/uploads/ /app/uploads/
COPY --from=build --chown=1000:1000 /runtime/logs/ /app/logs/
USER 1000:1000
# Keep node commands compatible with smoke checks and migration commands.
ENTRYPOINT []
# API binds loopback; use host networking on Linux.
CMD ["node", "dist/main.js"]
