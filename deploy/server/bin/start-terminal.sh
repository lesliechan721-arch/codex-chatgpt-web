#!/bin/sh
set -eu

/opt/codex-server/bin/wait-for-x.sh
exec /usr/bin/xterm \
  -fa DejaVuSansMono \
  -fs 11 \
  -title "Server Terminal" \
  -e /bin/bash -lc 'cd "$HOME" && exec /bin/bash -i'
