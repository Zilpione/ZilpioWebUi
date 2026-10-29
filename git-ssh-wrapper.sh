#!/bin/sh
if [ -s "$CODEX_WEBUI_GIT_IDENTITY" ]; then
  exec ssh -o IdentitiesOnly=yes -o "UserKnownHostsFile=$CODEX_WEBUI_KNOWN_HOSTS" -o StrictHostKeyChecking=accept-new -i "$CODEX_WEBUI_GIT_IDENTITY" "$@"
fi
exec ssh "$@"
