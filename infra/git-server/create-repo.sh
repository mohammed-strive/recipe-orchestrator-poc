#!/bin/sh
# Creates an empty bare repo for a new plugin so it can be pushed to.
#   podman compose exec git-server create-repo.sh <plugin>
set -eu
repo="/srv/git/$1.git"
if [ -d "$repo" ]; then echo "exists: $repo"; exit 0; fi
git init -q --bare -b main "$repo"
git -C "$repo" config daemon.receivepack true
echo "created: $repo"
