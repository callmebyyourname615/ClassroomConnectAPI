# API Docker image — Step 1

This repository produces one reusable NestJS image. Each school runs a separate container with its own environment, port, database role, JWT secret and upload/log volumes.

## Build

Run in this repository on a Docker-enabled build machine:

```bash
docker build --pull --platform linux/amd64 -t alphaschool-api:step1 .
```

CI should supply a tested, pinned Node base image digest using `--build-arg NODE_IMAGE=...`, then publish/tag the application image by commit and deploy its digest.

The build uses `npm ci`, compiles NestJS, and installs production-only dependencies in a separate stage. Runtime uses the image's `node` user (UID/GID 1000) and directly starts `node dist/main.js`, bypassing the package script that tries to free the selected port.

## Runtime contract

- The API's existing `127.0.0.1` binding is unchanged.
- On the Ubuntu VPS, run with **host networking** and a unique `PORT` per school. `docker run -p ...` alone cannot reach this binding inside a bridge-network container.
- Host-network containers share the VPS network namespace; this is not network isolation between schools.
- Supply `PORT`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASS`, `JWT_SECRET`, `API_PREFIX`, `CORS_ORIGINS` and other production settings using a protected runtime env file.
- Set `TYPEORM_SYNCHRONIZE=false` and `NODE_ENV=production`. This does not disable the existing SchemaAlignmentService; that service must be addressed in the database readiness phase before using a restricted runtime DB role.
- Preserve `/app/uploads` and `/app/logs` in distinct named volumes per school. Fresh Docker named volumes inherit the image directory contents/ownership; pre-existing volumes and bind mounts need their permissions prepared separately for UID 1000. Do not run as root to hide permission problems.
- `.env`, dependency directories, uploads, logs, credentials and dumps are excluded from the build context. No local env file is packaged.
- Nginx and Certbot configuration are handled by the other operator.

Example **after** preparing this school's env file and database:

```bash
docker run -d --init --name school-a-api \
  --network host \
  --env-file /etc/alphaschool/secrets/school-a/api.env \
  -v school-a-api-uploads:/app/uploads \
  -v school-a-api-logs:/app/logs \
  alphaschool-api:step1
```

Set the school's port in its env file. Do not use the same port for two schools. This example is a manual smoke run, not the final Compose deployment or resource-limit configuration.

## Compiled migration artifact

The image contains the compiled TypeORM data source and migrations. No ts-node or development dependency is needed:

```bash
docker run --rm --network host \
  --env-file /etc/alphaschool/secrets/school-a/migration.env \
  alphaschool-api:step1 \
  node node_modules/typeorm/cli.js \
  -d dist/database/data-source.js migration:run --transaction each
```

Use a separate migration account, verify backup/schema compatibility first, and serialize migration execution. Do not run migrations automatically every time a container restarts.

## Step 1 acceptance

- [x] Image builds from the committed lockfile without local node_modules or `.env`.
- [x] Runtime user is non-root; uploads/log directories are writable.
- [x] bcrypt, sharp, pg and TypeORM load in the Linux runtime image.
- [x] Compiled migration CLI is available.
- [x] API bind remains `127.0.0.1`.
- [ ] Per-school database, persistent volumes and application readiness are tested in the following phases.

## Repeat the image smoke checks

Run on a Linux Docker host after building the image:

```bash
bash scripts/docker-smoke.sh alphaschool-api:step1
```

These are image packaging checks, not full application/database acceptance. Frontend checks start a temporary server on an unused loopback port and remove it afterward. API checks do not start the API or connect to a database.

Verified on the Ubuntu amd64 VPS on 2026-10-06. A temporary image build and image-only smoke checks passed. No API instance or database was deployed for these checks.
