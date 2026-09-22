#!/bin/sh
set -eu

i=0
while [ "$i" -lt 100 ]; do
  if /usr/bin/xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    exit 0
  fi
  i=$((i + 1))
  sleep 0.1
done

echo "X display $DISPLAY did not become ready" >&2
exit 1
