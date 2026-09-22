#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

IMAGE="lesliechan721/codex-chatgpt-web"
VERSION="$(bun -e 'console.log(require("./package.json").version)')"

docker buildx build \
  --platform linux/amd64 \
  --file deploy/server/Dockerfile \
  --tag "$IMAGE:$VERSION" \
  --tag "$IMAGE:latest" \
  --push \
  .
