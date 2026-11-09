#!/usr/bin/env bash
# Real gateway E2E; a unique disposable stack, always reclaimed, including on failure.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export SUB2API_IMAGE="${SUB2API_IMAGE:-weishaw/sub2api:latest}"
SUB2API_IMAGE_TAG="$(printf %s "$SUB2API_IMAGE" | tr '/:' '--' | tr -c 'a-zA-Z0-9._-' '-')"
export SUB2API_IMAGE_TAG
export TEST_COMPOSE_PROJECT="mpjmds-$$"
dc() { docker compose -p "$TEST_COMPOSE_PROJECT" -f "$here/compose.yml" "$@"; }
export STATE="$here/.state/state-$$.json"
down() {
  local code=$?
  if [ "$code" -ne 0 ]; then dc logs --no-color --tail 80 sub2api >&2 || true; fi
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$STATE"
  exit "$code"
}
trap down EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '== sub2api %s (compose project %s)\n' "$SUB2API_IMAGE" "$TEST_COMPOSE_PROJECT"
if ! docker image inspect "$SUB2API_IMAGE" >/dev/null 2>&1; then dc pull --quiet sub2api; fi
dc up -d --quiet-pull
port="$(dc port sub2api 8080)"
base="http://127.0.0.1:${port##*:}"
docker image inspect "$SUB2API_IMAGE" --format 'image {{.Id}} created {{.Created}}'
mkdir -p "$here/.state" "$here/artifacts/$SUB2API_IMAGE_TAG"
node "$here/setup.mjs" "$base" >"$STATE"
curl -fsS "$base/health" >/dev/null
node --test --test-reporter=spec "$here/plugin.test.mjs" "$here/errors.test.mjs"
