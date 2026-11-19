#!/bin/sh
# Publishes marketplace/plugins/<plugin>/<version> to the local marketplace (git-server
# container) as tag v<version>, then asks the registry to re-index (indexing on publish).
#
#   tools/publish-plugin.sh <plugin> <version>
set -eu
cd "$(dirname "$0")/.."
plugin="$1"
version="$2"
src="marketplace/plugins/$plugin/$version"
[ -d "$src" ] || { echo "No such folder: $src" >&2; exit 1; }
url="${GIT_BASE_URL:-git://localhost:9418}/$plugin.git"
# Compose command used to reach the git-server container. Override with COMPOSE="docker compose".
COMPOSE="${COMPOSE:-podman compose}"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME="POC Marketplace" GIT_AUTHOR_EMAIL="marketplace@example.local"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if git ls-remote "$url" >/dev/null 2>&1; then
  git clone -q "$url" "$work" 2>/dev/null || git init -q -b main "$work"
else
  echo "Creating repository for new plugin $plugin"
  $COMPOSE exec -T git-server create-repo.sh "$plugin"
  git init -q -b main "$work"
fi
git -C "$work" config core.fileMode false
if git -C "$work" rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  echo "$plugin v$version is already published. Versions are immutable: use a new version number." >&2
  exit 1
fi
find "$work" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} \;
cp -R "$src/." "$work/"
git -C "$work" add -A
git -C "$work" commit -q -m "Release $plugin v$version"
git -C "$work" tag "v$version"
git -C "$work" push -q "$url" HEAD:main "v$version"
echo "Published $plugin v$version at $(git -C "$work" rev-parse HEAD)"
echo "Re-indexing:"
curl -s -X POST "${REGISTRY_HTTP:-http://localhost:7300}/reindex"
echo
