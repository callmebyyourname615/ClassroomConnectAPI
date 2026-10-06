#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root' >&2; exit 1; }
SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
PUBLIC_KEY=${1:?Pass the API deployment .pub file}
grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$' "$PUBLIC_KEY"
[[ $(wc -l < "$PUBLIC_KEY") == 1 ]] || exit 2
for school in svtn aims; do
  test -f "/opt/classroomconnect/$school/compose.yaml"
  test -f "/opt/classroomconnect/$school/compose.release.yaml"
done
if ! id api-deploy >/dev/null 2>&1; then useradd --create-home --shell /bin/bash api-deploy; fi
install -o root -g root -m 755 "$SCRIPT_DIR/deploy-api.sh" /usr/local/sbin/deploy-classroomconnect-api
install -o root -g root -m 755 "$SCRIPT_DIR/api-dispatch.sh" /usr/local/bin/classroomconnect-api-dispatch
SUDO_RULE=$(mktemp)
trap 'rm -f -- "$SUDO_RULE"' EXIT
printf 'api-deploy ALL=(root) NOPASSWD: /usr/local/sbin/deploy-classroomconnect-api\n' > "$SUDO_RULE"
visudo -cf "$SUDO_RULE"
install -o root -g root -m 440 "$SUDO_RULE" /etc/sudoers.d/classroomconnect-api-deploy
install -o root -g root -m 755 -d /home/api-deploy/.ssh
printf 'restrict,command="/usr/local/bin/classroomconnect-api-dispatch" %s\n' "$(cat "$PUBLIC_KEY")" > /home/api-deploy/.ssh/authorized_keys
chown root:root /home/api-deploy/.ssh/authorized_keys
chmod 644 /home/api-deploy/.ssh/authorized_keys
echo 'Restricted shared API deployment identity installed'
