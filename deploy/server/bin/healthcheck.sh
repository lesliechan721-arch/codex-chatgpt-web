#!/bin/sh
set -eu

supervisor_config=/etc/supervisor/conf.d/codex-server.conf
for program in xvfb keyring openbox terminal vnc novnc launcher; do
  status="$(/usr/bin/supervisorctl -c "$supervisor_config" status "$program" 2>/dev/null | awk '{print $2}')"
  if [ "$status" != "RUNNING" ]; then
    echo "$program is not running" >&2
    exit 1
  fi
done

/usr/bin/curl --fail --silent --show-error --max-time 2 \
  http://127.0.0.1:6080/vnc.html >/dev/null

state_file="$CODEX_WEB_GPT_LAUNCHER_DATA_DIR/launcher-state.json"
runtime_required="$CODEX_CHATGPT_WEB_HOME/server/runtime-required"
if [ -f "$state_file" ] && grep -q '"coreSetupComplete"[[:space:]]*:[[:space:]]*true' "$state_file"; then
  : > "$runtime_required"
fi

if [ -f "$runtime_required" ]; then
  config_file="$CODEX_CHATGPT_WEB_HOME/config.json"
  if [ ! -r "$config_file" ]; then
    echo "Responses runtime config is unavailable" >&2
    exit 1
  fi
  runtime_port="$(/usr/local/bin/node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, ""));
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) process.exit(64);
    process.stdout.write(String(config.port));
  ' "$config_file")" || {
    echo "Responses runtime config has an invalid port" >&2
    exit 1
  }
  payload="$(/usr/bin/curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${runtime_port}/healthz")"
  printf '%s' "$payload" | grep -q '"service":"codex-chatgpt-web"'
  printf '%s' "$payload" | grep -q '"status":"ok"'
fi
