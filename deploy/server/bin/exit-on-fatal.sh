#!/bin/sh
set -eu

supervisor_config=/etc/supervisor/conf.d/codex-server.conf

while true; do
  printf 'READY\n'
  IFS= read -r header || exit 0
  event_length="$(printf '%s\n' "$header" | sed -n 's/.*len:\([0-9][0-9]*\).*/\1/p')"
  if [ -z "$event_length" ]; then
    echo "Supervisor FATAL event has no payload length" >&2
    exit 70
  fi

  payload="$(dd bs=1 count="$event_length" 2>/dev/null)"
  printf 'RESULT 2\nOK'

  case "$payload" in
    processname:xvfb\ *|processname:keyring\ *|processname:openbox\ *|processname:terminal\ *|processname:vnc\ *|processname:novnc\ *|processname:launcher\ *)
      program="$(printf '%s\n' "$payload" | sed -n 's/^processname:\([^ ]*\).*/\1/p')"
      echo "Critical supervisor process entered FATAL state: $program" >&2
      /usr/bin/supervisorctl -c "$supervisor_config" shutdown >/dev/null 2>&1 || true
      exit 0
      ;;
  esac
done
