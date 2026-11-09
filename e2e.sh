#!/bin/sh
# Real magpie manual smoke, isolated from your own configuration.
# JMDS_KEY=sk-... [JMDS_BASE_URL=https://...] [JMDS_NAME=work] ./e2e.sh
set -eu
: "${JMDS_KEY:?Set JMDS_KEY to a jmds API key}"
name=${JMDS_NAME-}
here=$(cd "$(dirname "$0")" && pwd)
sb=$here/.e2e/$(printf %s "$JMDS_KEY" | shasum | cut -c1-8)
rm -rf "$sb" && mkdir -p "$sb"
m=${MAGPIE:-$(command -v magpie || printf %s /Applications/magpie.app/Contents/MacOS/magpie)}
run() { env -i PATH="$PATH" HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" MAGPIE_PLUGIN_MARKET=off "$m" "$@"; }
printf '== %s\n' "$("$m" --version 2>/dev/null || printf %s "$m")"
printf '== plugin add\n'; run plugin add "$here" </dev/null
if [ -n "${JMDS_BASE_URL-}" ]; then
  options=$(JMDS_BASE_URL="$JMDS_BASE_URL" node -e 'process.stdout.write(JSON.stringify({baseURL:process.env.JMDS_BASE_URL}))')
  run plugin options magpie-jmds "$options" </dev/null
fi
printf '== plugin login jmds\n'; printf '%s\n%s\n' "$name" "$JMDS_KEY" | run plugin login jmds
printf '== quota\n'; run quota --json </dev/null
printf '== plugin list\n'; run plugin list </dev/null
printf '== models\n'; run models </dev/null | grep -i jmds
printf '== provider test jmds\n'; run provider test jmds </dev/null
