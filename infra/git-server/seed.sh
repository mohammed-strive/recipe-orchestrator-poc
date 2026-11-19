#!/bin/sh
# Seeds bare git repositories for every mock plugin.
#
#   seed.sh <plugins-source-dir> <bare-repos-dir>
#
# Source layout:  <plugins-source-dir>/<plugin>/<version>/...plugin files...
# Each version folder becomes one commit, tagged v<version>, in <bare-repos-dir>/<plugin>.git.
# Author, committer and dates are fixed, so the commit SHAs are identical on every machine.
# That lets recipes pin real SHAs. Existing repos are left untouched.
set -eu

SRC="$1"
DEST="$2"
mkdir -p "$DEST"

# Ignore the user's git config (commit signing, autocrlf, hooks, ...) so SHAs are identical everywhere.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME="POC Marketplace"
export GIT_AUTHOR_EMAIL="marketplace@example.local"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

for plugin_dir in "$SRC"/*/; do
  plugin=$(basename "$plugin_dir")
  bare="$DEST/$plugin.git"
  if [ -d "$bare" ]; then
    echo "seed: $plugin already exists, skipping"
    continue
  fi
  git init -q --bare -b main "$bare"
  work=$(mktemp -d)
  git init -q -b main "$work"
  git -C "$work" config core.fileMode false
  git -C "$work" config core.autocrlf false
  n=0
  for version in $(ls "$plugin_dir" | sort -t. -k1,1n -k2,2n -k3,3n); do
    n=$((n + 1))
    # Replace the working tree with this version's files.
    find "$work" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} \;
    cp -R "$plugin_dir/$version/." "$work/"
    git -C "$work" add -A
    stamp="2026-01-01T00:0${n}:00Z"
    GIT_AUTHOR_DATE="$stamp" GIT_COMMITTER_DATE="$stamp" \
      git -C "$work" commit -q -m "Release $plugin v$version"
    git -C "$work" tag "v$version"
    echo "seed: $plugin v$version $(git -C "$work" rev-parse HEAD)"
  done
  git -C "$work" push -q "$bare" main --tags
  rm -rf "$work"
done
