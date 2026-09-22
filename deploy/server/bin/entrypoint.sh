#!/bin/sh
set -eu

umask 077

for path in \
  "$HOME" \
  "$CODEX_CHATGPT_WEB_HOME" \
  "$CODEX_WEB_GPT_LAUNCHER_DATA_DIR" \
  "$CODEX_CHATGPT_WEB_HOME/server" \
  "$XDG_RUNTIME_DIR"
do
  mkdir -p "$path"
done

chmod 0700 "$XDG_RUNTIME_DIR"

if [ ! -r "$VNC_PASSWORD_FILE" ]; then
  echo "VNC password secret is not readable at $VNC_PASSWORD_FILE" >&2
  exit 70
fi
if [ ! -r "$KEYRING_PASSWORD_FILE" ]; then
  echo "Keyring password secret is not readable at $KEYRING_PASSWORD_FILE" >&2
  exit 70
fi
if [ ! -x "$APPIMAGE_PATH" ]; then
  echo "Production AppImage is not executable at $APPIMAGE_PATH" >&2
  exit 70
fi

exec /usr/bin/dbus-run-session -- /opt/codex-server/bin/run-supervisor.sh
