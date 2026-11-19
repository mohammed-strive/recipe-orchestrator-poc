#!/bin/sh
set -eu
git config --global --add safe.directory '*'
/usr/local/bin/seed.sh /seed/plugins /srv/git
# Allow pushes so tools/publish-plugin.sh can publish new plugin versions.
for repo in /srv/git/*.git; do
  git -C "$repo" config daemon.receivepack true
done
touch /tmp/seeded
echo "git-server: serving $(ls /srv/git | wc -l) plugin repositories on :9418"
exec git daemon --reuseaddr --base-path=/srv/git --export-all \
  --enable=receive-pack --informative-errors --verbose /srv/git
