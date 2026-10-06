#!/usr/bin/env bash
set -euo pipefail
COMMAND=${SSH_ORIGINAL_COMMAND:-}
PATTERN='^deploy (ghcr\.io/callmebyyourname615/alpha_api@sha256:[a-f0-9]{64}) ([a-f0-9]{40}) ([A-Za-z0-9_-]+)$'
if [[ "$COMMAND" =~ $PATTERN ]]; then
  exec sudo -n /usr/local/sbin/deploy-classroomconnect-api \
    "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
fi
echo 'Only a shared API deployment command is permitted' >&2
exit 2
