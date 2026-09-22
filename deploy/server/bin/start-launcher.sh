#!/bin/sh
set -eu

/opt/codex-server/bin/wait-for-x.sh

i=0
while [ "$i" -lt 100 ]; do
  if /usr/bin/dbus-send \
    --session \
    --dest=org.freedesktop.secrets \
    --type=method_call \
    --print-reply \
    /org/freedesktop/secrets \
    org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1
  then
    break
  fi
  i=$((i + 1))
  sleep 0.1
done
if [ "$i" -ge 100 ]; then
  echo "Secret Service did not become ready" >&2
  exit 1
fi

exec "$APPIMAGE_PATH" --password-store=gnome-libsecret
