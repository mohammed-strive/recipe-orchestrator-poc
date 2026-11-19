#!/bin/sh
# Prints every published plugin version and its commit SHA, for pinning in recipes.
set -eu
cd "$(dirname "$0")/.."
base="${GIT_BASE_URL:-git://localhost:9418}"
for dir in marketplace/plugins/*/; do
  plugin=$(basename "$dir")
  GIT_CONFIG_GLOBAL=/dev/null git ls-remote --tags "$base/$plugin.git" 2>/dev/null \
    | sed -n 's#^\([0-9a-f]*\)\trefs/tags/v\([^^]*\)$#\2 \1#p' \
    | while read -r version sha; do printf '%-20s %-8s %s\n' "$plugin" "$version" "$sha"; done
done
