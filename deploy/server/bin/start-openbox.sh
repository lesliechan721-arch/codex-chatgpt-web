#!/bin/sh
set -eu

/opt/codex-server/bin/wait-for-x.sh
exec /usr/bin/openbox
