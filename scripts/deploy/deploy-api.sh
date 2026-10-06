#!/usr/bin/env bash
set -euo pipefail
umask 077
IMAGE=${1:-}
REVISION=${2:-}
REGISTRY_USER=${3:-}
[[ $(id -u) == 0 ]] || exit 1
[[ $# == 3 ]] || exit 2
[[ "$IMAGE" =~ ^ghcr\.io/callmebyyourname615/alpha_api@sha256:[a-f0-9]{64}$ ]] || exit 2
[[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ "$REGISTRY_USER" =~ ^[A-Za-z0-9_-]+$ ]] || exit 2
for command in docker python3 curl flock runuser; do command -v "$command" >/dev/null; done
exec 9>/opt/classroomconnect/api-deploy.lock
flock -w 600 9
AUTH_DIR=$(mktemp -d /tmp/cc-api-registry.XXXXXX)
STOPPED=false
STAGE=preflight
cleanup() {
  status=$?
  trap - EXIT
  if [[ "$STOPPED" == true ]]; then
    echo "$SCHOOL: deployment failed at $STAGE; restoring the previous API image" >&2
    if cp "$ENV_BACKUP" "$APP_DIR/.env" && "${COMPOSE[@]}" up -d --no-deps --force-recreate --pull never --no-build --wait --wait-timeout 180 api && verify; then
      record "failed-$STAGE-image-restored"
    else
      record "failed-$STAGE-recovery-failed"
      echo "$SCHOOL: recovery failed; operator action required" >&2
    fi
    echo "Committed database migrations were NOT reverted. Backup: $BACKUP" >&2
    status=1
  fi
  case "$AUTH_DIR" in /tmp/cc-api-registry.*) rm -rf -- "$AUTH_DIR" ;; esac
  exit "$status"
}
trap cleanup EXIT
# Receive the short-lived workflow token through stdin, never command arguments.
docker --config "$AUTH_DIR" login ghcr.io -u "$REGISTRY_USER" --password-stdin
docker --config "$AUTH_DIR" pull "$IMAGE"
verify() {
  for port in "$API_PORT" "$FRONTEND_PORT"; do
    curl --fail --silent --show-error --max-time 20 "http://127.0.0.1:$port/api/v2/health" |
      python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("status")=="ok" and d.get("database")=="ok" else 1)' || return 1
  done
}
record() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$REVISION" "$IMAGE" "$1" "$PREVIOUS" "$BACKUP" >> "$APP_DIR/releases/api.tsv"
}
for SCHOOL in svtn aims; do
  case "$SCHOOL" in
    svtn) API_PORT=4101; FRONTEND_PORT=3101 ;;
    aims) API_PORT=4102; FRONTEND_PORT=3102 ;;
  esac
  APP_DIR=/opt/classroomconnect/$SCHOOL
  cd "$APP_DIR"
  STAGE=preflight
  COMPOSE=(docker compose --project-directory "$APP_DIR" -f compose.yaml -f compose.release.yaml)
  "${COMPOSE[@]}" config --quiet
  CONTAINER=$("${COMPOSE[@]}" ps -q api)
  test -n "$CONTAINER"
  PREVIOUS=$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")
  [[ "$PREVIOUS" =~ ^ghcr\.io/callmebyyourname615/alpha_api@sha256:[a-f0-9]{64}$ ]] || exit 2
  # Validate the rendered image and migration connection, without printing secrets.
  "${COMPOSE[@]}" config --format json | python3 -c 'import json,sys; assert json.load(sys.stdin)["services"]["api"]["image"]==sys.argv[1], "API config differs from running image"' "$PREVIOUS"
  "${COMPOSE[@]}" run --rm --no-deps -T --pull never --entrypoint node api -e '
    const {Client}=require("pg");
    const school=process.argv[1];
    (async()=>{
      if(process.env.DB_NAME!==school+"_school_db" || process.env.DB_USER!==school || process.env.DB_HOST!=="127.0.0.1" || process.env.TYPEORM_SYNCHRONIZE!=="false") throw Error("Unexpected migration database configuration");
      const c=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME});
      try { await c.connect(); const r=await c.query("select current_database() as db, current_user as role"); if(r.rows[0].db!==school+"_school_db" || r.rows[0].role!==school) throw Error("Unexpected database identity"); }
      finally { await c.end(); }
    })().catch(()=>{console.error("Migration database preflight failed");process.exitCode=1});
  ' "$SCHOOL"
  mkdir -p releases/backups
  RELEASE=$(mktemp -d "$APP_DIR/releases/backups/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
  ENV_BACKUP=$RELEASE/compose.env.before
  BACKUP=$RELEASE/database.dump
  cp .env "$ENV_BACKUP"
  # Validate the single image assignment before stopping the API.
  python3 - "$IMAGE" <<'PY'
from pathlib import Path
import re,sys
p=Path('.env')
s=p.read_text()
assert len(re.findall(r'^API_IMAGE=.*$',s,re.M))==1, 'Expected exactly one API_IMAGE'
p.with_name('.env.api-next').write_text(re.sub(r'^API_IMAGE=.*$',lambda _: 'API_IMAGE='+sys.argv[1],s,flags=re.M))
p.with_name('.env.api-next').chmod(0o600)
PY
  STAGE=backup
  STOPPED=true
  "${COMPOSE[@]}" stop api
  runuser -u postgres -- pg_dump --format=custom --no-owner --no-acl --dbname="${SCHOOL}_school_db" > "$BACKUP.partial"
  runuser -u postgres -- pg_restore --list < "$BACKUP.partial" > /dev/null
  mv "$BACKUP.partial" "$BACKUP"
  STAGE=migration
  mv .env.api-next .env
  "${COMPOSE[@]}" run --rm --no-deps -T --pull never --entrypoint node api \
    node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js --transaction each \
    > "$RELEASE/migration.log" 2>&1
  STAGE=health
  "${COMPOSE[@]}" up -d --no-deps --force-recreate --pull never --no-build --wait --wait-timeout 180 api
  verify
  STOPPED=false
  record success
  echo "$SCHOOL: API deployed $REVISION; backup $BACKUP"
done
