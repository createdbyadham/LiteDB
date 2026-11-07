#!/usr/bin/env bash
# Push the generated manifest to flathub/com.adhamehab.litedb.
# The repo is created by Flathub when the app is accepted, not by this script.
set -euo pipefail
version=${1:?version}
manifest_dir=${2:?manifest directory}
root=$(cd "$(dirname "$0")/../.." && pwd)
upstream=flathub/com.adhamehab.litedb

if ! gh repo view "$upstream" >/dev/null 2>&1; then
  echo "::error::${upstream} does not exist yet. Download the flathub-manifest artifact and submit it: https://github.com/flathub/flathub/wiki/App-Submission"
  exit 1
fi

files=""
while IFS= read -r path; do
  rel=${path#"${manifest_dir}/"}
  files+="${rel}=${path}"$'\n'
done < <(find "$manifest_dir" -type f | sort)

cd "$root"
export FILES="$files"
export COMMIT_MESSAGE="Update to ${version}"
export PR_BODY="LiteDB ${version}, built from the tagged source.

- https://github.com/createdbyadham/LiteDB/releases/tag/v${version}"
bash packaging/publish/fork-pr.sh "$upstream" "litedb-${version}" "Update LiteDB to ${version}"
