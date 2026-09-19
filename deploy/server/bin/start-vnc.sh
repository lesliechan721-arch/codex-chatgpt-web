#!/bin/sh
set -eu

/opt/codex-server/bin/wait-for-x.sh
umask 077

if [ ! -r "$VNC_PASSWORD_FILE" ]; then
  echo "VNC password secret is not readable at $VNC_PASSWORD_FILE" >&2
  exit 70
fi

vnc_password="$(head -n 1 "$VNC_PASSWORD_FILE")"
if [ "${#vnc_password}" -lt 8 ]; then
  echo "VNC password must contain at least 8 characters" >&2
  exit 70
fi

auth_file="$XDG_RUNTIME_DIR/x11vnc.pass"
printf '%s\n' "$vnc_password" | /usr/bin/tigervncpasswd -f > "$auth_file"
unset vnc_password
chmod 0600 "$auth_file"

exec /usr/bin/x11vnc \
  -display "$DISPLAY" \
  -localhost \
  -rfbport 5900 \
  -rfbauth "$auth_file" \
  -forever \
  -shared \
  -repeat \
  -noxdamage
