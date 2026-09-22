#!/bin/sh
set -eu

umask 077

if [ ! -r "$KEYRING_PASSWORD_FILE" ]; then
  echo "Keyring password secret is not readable at $KEYRING_PASSWORD_FILE" >&2
  exit 70
fi

keyring_password="$(head -n 1 "$KEYRING_PASSWORD_FILE")"
if [ -z "$keyring_password" ]; then
  echo "Keyring password secret must not be empty" >&2
  exit 70
fi

# GNOME Keyring needs an unlock credential in a session without PAM login.
# Keep this credential independent from VNC authentication so VNC password
# rotation cannot invalidate safeStorage entries protected by the keyring.

printf '%s\n' "$keyring_password" \
  | /usr/bin/gnome-keyring-daemon --foreground --components=secrets --unlock
