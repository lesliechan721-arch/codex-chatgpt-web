#!/bin/sh
set -eu

umask 077

if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  echo "D-Bus session address is unavailable" >&2
  exit 70
fi

address_file="$XDG_RUNTIME_DIR/dbus-session-address"
printf '%s\n' "$DBUS_SESSION_BUS_ADDRESS" > "$address_file"
chmod 0600 "$address_file"

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/codex-server.conf
