#!/usr/bin/env bash
set -euo pipefail
tag=${1:?release tag}
root=$(cd "$(dirname "$0")/../.." && pwd)
version=${tag#v}
if [ "$tag" != "v${version}" ]; then
  echo "::error::Scoop manifest expects tag v<version>, got ${tag}"
  exit 1
fi

url="https://github.com/createdbyadham/LiteDB/releases/download/${tag}/LiteDB_${version}_x64-setup.exe"
hash=$(curl -fsSL "$url" | sha256sum | awk '{print $1}')
rendered=$(mktemp)
VERSION="$version" HASH="$hash" TEMPLATE="${root}/packaging/scoop/litedb.json" OUT="$rendered" python3 - <<'PY'
import json, os, pathlib
data = json.loads(pathlib.Path(os.environ["TEMPLATE"]).read_text())
version = os.environ["VERSION"]
data["version"] = version
data["architecture"]["64bit"]["url"] = (
    "https://github.com/createdbyadham/LiteDB/releases/download/"
    f"v{version}/LiteDB_{version}_x64-setup.exe#/dl.7z"
)
data["architecture"]["64bit"]["hash"] = os.environ["HASH"]
pathlib.Path(os.environ["OUT"]).write_text(json.dumps(data, indent=4) + "\n")
PY

cd "$root"
export FILES="bucket/litedb.json=${rendered}"
export COMMIT_MESSAGE="litedb: Update to version ${version}"
export PR_BODY="Authenticode-signed LiteDB ${version}.

- https://github.com/createdbyadham/LiteDB/releases/tag/${tag}"
bash packaging/publish/fork-pr.sh ScoopInstaller/Extras "litedb-${version}" "litedb: Update to version ${version}"
