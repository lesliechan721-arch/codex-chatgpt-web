#!/bin/sh
set -eu

if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  address_file="$XDG_RUNTIME_DIR/dbus-session-address"
  if [ ! -r "$address_file" ]; then
    echo "D-Bus session address file is unavailable" >&2
    exit 70
  fi
  DBUS_SESSION_BUS_ADDRESS="$(cat "$address_file")"
  export DBUS_SESSION_BUS_ADDRESS
fi

probe_id="server-probe-$$-$(date +%s)"
probe_value="$(cat /proc/sys/kernel/random/uuid)"

cleanup() {
  /usr/bin/secret-tool clear codex-web-gpt-server-probe "$probe_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

printf '%s' "$probe_value" \
  | /usr/bin/secret-tool store --label="Codex Web GPT server probe" codex-web-gpt-server-probe "$probe_id"
readback="$(/usr/bin/secret-tool lookup codex-web-gpt-server-probe "$probe_id")"
if [ "$readback" != "$probe_value" ]; then
  echo "Secret Service probe failed" >&2
  exit 1
fi

echo "Secret Service store/read probe passed"
